package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/xuri/excelize/v2"
)

type exportStudent struct {
	id    int64
	name  string
	grade map[int64]*int // lab_id -> value (nil = absent)
}

type exportLab struct {
	id         int64
	number     int
	name       string
	weight     float64
	weightText string
	required   bool
	archived   bool
}

// exportGradebook builds an .xlsx workbook for one subject+group. It mirrors the
// server-side weighted-grading rules so the spreadsheet and the UI agree:
//   - required lab without a grade counts as 2 and blocks the final hint
//   - optional lab without a grade is excluded entirely (weight too)
//   - archived labs are excluded
//   - final hint uses exact unrounded mean, half-up rounded to an integer
//   - average is shown with two decimals
//
// Formulas are embedded so the owner can continue calculating in Excel.
func (s *server) exportGradebook(w http.ResponseWriter, r *http.Request, uid int64) {
	ctx := r.Context()
	subjectID, e := strconv.ParseInt(r.URL.Query().Get("subject_id"), 10, 64)
	if e != nil || subjectID <= 0 {
		writeError(w, fail("Нужен subject_id"))
		return
	}
	groupID, e := strconv.ParseInt(r.URL.Query().Get("group_id"), 10, 64)
	if e != nil || groupID <= 0 {
		writeError(w, fail("Нужен group_id"))
		return
	}
	tx, e := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		writeError(w, e)
		return
	}
	defer tx.Rollback(ctx)

	if !s.allowed(ctx, tx, uid) {
		writeError(w, forbidden())
		return
	}

	if !exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM groups g, subjects s WHERE g.id=$1 AND s.id=$2)", groupID, subjectID) {
		writeError(w, fail("Группа или предмет не найдены"))
		return
	}

	if err := requireCurriculum(ctx, tx, subjectID, groupID, false); err != nil {
		writeError(w, err)
		return
	}

	var labList []exportLab
	rows, e := tx.Query(ctx, `
		SELECT l.id,l.number,l.name,l.weight,l.weight::text,l.required,l.archived
		FROM labs l
		WHERE l.subject_id=$1 AND l.group_id=$2 AND NOT l.archived
		ORDER BY l.number,l.id`, subjectID, groupID)
	if e != nil {
		writeError(w, e)
		return
	}
	for rows.Next() {
		var l exportLab
		var wt sql.NullString
		if e := rows.Scan(&l.id, &l.number, &l.name, &l.weight, &wt, &l.required, &l.archived); e != nil {
			rows.Close()
			writeError(w, e)
			return
		}
		l.weightText = wt.String
		labList = append(labList, l)
	}
	rows.Close()

	var studentList []exportStudent
	rows, e = tx.Query(ctx, `
		SELECT u.id,u.name
		FROM users u
		WHERE u.group_id=$1 AND NOT u.teacher
		ORDER BY u.name,u.id`, groupID)
	if e != nil {
		writeError(w, e)
		return
	}
	for rows.Next() {
		var st exportStudent
		if e := rows.Scan(&st.id, &st.name); e != nil {
			rows.Close()
			writeError(w, e)
			return
		}
		st.grade = map[int64]*int{}
		studentList = append(studentList, st)
	}
	rows.Close()

	rows, e = tx.Query(ctx, `
		SELECT g.student_id,g.lab_id,g.value
		FROM grades g
		JOIN labs l ON l.id=g.lab_id
		WHERE l.subject_id=$1 AND l.group_id=$2 AND NOT l.archived`, subjectID, groupID)
	if e != nil {
		writeError(w, e)
		return
	}
	for rows.Next() {
		var studentID, labID int64
		var value sql.NullInt64
		if e := rows.Scan(&studentID, &labID, &value); e != nil {
			rows.Close()
			writeError(w, e)
			return
		}
		if st, ok := studentByID(studentList, studentID); ok {
			if value.Valid {
				v := int(value.Int64)
				st.grade[labID] = &v
			} else {
				st.grade[labID] = nil
			}
		}
	}
	rows.Close()

	if e = tx.Commit(ctx); e != nil {
		writeError(w, e)
		return
	}

	sort.Slice(studentList, func(i, j int) bool {
		if studentList[i].name != studentList[j].name {
			return studentList[i].name < studentList[j].name
		}
		return studentList[i].id < studentList[j].id
	})

	f := excelize.NewFile()
	defer f.Close()
	sheet := "Ведомость"
	f.SetSheetName("Sheet1", sheet)

	// Header row.
	headers := []any{"Студент"}
	for _, l := range labList {
		headers = append(headers, fmt.Sprintf("ЛР %d · %s", l.number, l.name))
	}
	headers = append(headers, "Средний балл", "Итог (подсказка)", "Сдано / всего")
	for col, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(col+1, 1)
		f.SetCellValue(sheet, cell, h)
	}

	// Style header bold.
	headerStyle, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	for col := 1; col <= len(headers); col++ {
		cell, _ := excelize.CoordinatesToCellName(col, 1)
		f.SetCellStyle(sheet, cell, cell, headerStyle)
	}

	// Data rows.
	startRow := 2
	for i, st := range studentList {
		row := startRow + i
		nameCell, _ := excelize.CoordinatesToCellName(1, row)
		f.SetCellValue(sheet, nameCell, st.name)

		labCol := 2
		for _, l := range labList {
			cell, _ := excelize.CoordinatesToCellName(labCol, row)
			if v, ok := st.grade[l.id]; ok && v != nil {
				f.SetCellValue(sheet, cell, *v)
			} else {
				f.SetCellValue(sheet, cell, "")
			}
			labCol++
		}

		// Average formula: weighted mean over included labs.
		// Required without grade counts as 2; optional without grade excluded.
		avgParts := []string{"0"}
		weightParts := []string{"0"}
		labCol = 2
		for _, l := range labList {
			cell, _ := excelize.CoordinatesToCellName(labCol, row)
			if l.required {
				avgParts = append(avgParts, fmt.Sprintf("%s*IF(%s=\"\",2,%s)", l.weightText, cell, cell))
				weightParts = append(weightParts, l.weightText)
			} else {
				avgParts = append(avgParts, fmt.Sprintf("IF(%s=\"\",0,%s*%s)", cell, cell, l.weightText))
				weightParts = append(weightParts, fmt.Sprintf("IF(%s=\"\",0,%s)", cell, l.weightText))
			}
			labCol++
		}
		avgFormula := fmt.Sprintf("IF(SUM(%s)=0,\"\",ROUND(SUM(%s)/SUM(%s),2))",
			strings.Join(weightParts, ","), strings.Join(avgParts, ","), strings.Join(weightParts, ","))
		avgCell, _ := excelize.CoordinatesToCellName(len(labList)+2, row)
		f.SetCellFormula(sheet, avgCell, avgFormula)
		avgStyle, _ := f.NewStyle(&excelize.Style{NumFmt: 2})
		f.SetCellStyle(sheet, avgCell, avgCell, avgStyle)

		// Final hint: only if all required passed and denominator > 0.
		requiredPassedParts := []string{"0"}
		requiredTotalParts := []string{"0"}
		labCol = 2
		for _, l := range labList {
			cell, _ := excelize.CoordinatesToCellName(labCol, row)
			if l.required {
				requiredTotalParts = append(requiredTotalParts, "1")
				requiredPassedParts = append(requiredPassedParts, fmt.Sprintf("IF(AND(%s<>\"\",%s>=3),1,0)", cell, cell))
			}
			labCol++
		}
		finalFormula := fmt.Sprintf(
			`IF(AND(SUM(%s)=SUM(%s),SUM(%s)>0),ROUND(SUM(%s)/SUM(%s),0),IF(SUM(%s)=0,"Нет данных","Не все обязательные работы сданы"))`,
			strings.Join(requiredPassedParts, ","), strings.Join(requiredTotalParts, ","),
			strings.Join(weightParts, ","),
			strings.Join(avgParts, ","), strings.Join(weightParts, ","),
			strings.Join(weightParts, ","),
		)
		finalCell, _ := excelize.CoordinatesToCellName(len(labList)+3, row)
		f.SetCellFormula(sheet, finalCell, finalFormula)

		// Passed / total: required labs with grade >= 3 divided by required total.
		passedParts := []string{"0"}
		labCol = 2
		for _, l := range labList {
			cell, _ := excelize.CoordinatesToCellName(labCol, row)
			if l.required {
				passedParts = append(passedParts, fmt.Sprintf("IF(AND(%s<>\"\",%s>=3),1,0)", cell, cell))
			}
			labCol++
		}
		progressFormula := fmt.Sprintf("SUM(%s)&\" / \"&SUM(%s)",
			strings.Join(passedParts, ","), strings.Join(requiredTotalParts, ","))
		progressCell, _ := excelize.CoordinatesToCellName(len(labList)+4, row)
		f.SetCellFormula(sheet, progressCell, progressFormula)
	}

	// Column widths.
	widths := []int{26}
	for range labList {
		widths = append(widths, 22)
	}
	widths = append(widths, 14, 26, 16)
	for col, width := range widths {
		colName, _ := excelize.ColumnNumberToName(col + 1)
		f.SetColWidth(sheet, colName, colName, float64(width))
	}

	if s.token == "" {
		writeError(w, fail("Отправка недоступна: бот не настроен"))
		return
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	if e = form.WriteField("chat_id", strconv.FormatInt(uid, 10)); e != nil {
		writeError(w, e)
		return
	}
	part, e := form.CreateFormFile("document", fmt.Sprintf("labturn_gradebook_%d_%d.xlsx", subjectID, groupID))
	if e != nil {
		writeError(w, e)
		return
	}
	if e = f.Write(part); e != nil {
		writeError(w, e)
		return
	}
	if e = form.Close(); e != nil {
		writeError(w, e)
		return
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.telegram.org/bot"+s.token+"/sendDocument", &body)
	if e != nil {
		writeError(w, fail("Не удалось подготовить отправку ведомости"))
		return
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	client := &http.Client{Timeout: 45 * time.Second}
	response, e := client.Do(req)
	if e != nil {
		writeError(w, fail("Telegram не подтвердил отправку. Проверьте личный чат с ботом перед повтором"))
		return
	}
	defer response.Body.Close()
	var result struct {
		OK        bool `json:"ok"`
		ErrorCode int  `json:"error_code"`
	}
	if e = json.NewDecoder(response.Body).Decode(&result); e != nil {
		writeError(w, fail("Telegram не подтвердил отправку. Проверьте личный чат с ботом перед повтором"))
		return
	}
	if response.StatusCode != http.StatusOK || !result.OK {
		message := "Не удалось отправить ведомость через Telegram. Попробуйте позже"
		if result.ErrorCode == 403 || result.ErrorCode == 400 {
			message = "Откройте личный чат с @labturn_bot, нажмите Старт и разрешите боту отправлять сообщения, затем повторите экспорт"
		}
		writeError(w, fail(message))
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func studentByID(list []exportStudent, id int64) (*exportStudent, bool) {
	for i := range list {
		if list[i].id == id {
			return &list[i], true
		}
	}
	return nil, false
}
