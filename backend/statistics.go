package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"

	"github.com/jackc/pgx/v5"
)

type gradeDistribution struct {
	Missing int64 `json:"missing"`
	Two     int64 `json:"2"`
	Three   int64 `json:"3"`
	Four    int64 `json:"4"`
	Five    int64 `json:"5"`
}

type gradeStatistics struct {
	SubjectID         int64             `json:"subject_id"`
	GroupID           int64             `json:"group_id"`
	StudentsCount     int64             `json:"students_count"`
	LabsCount         int64             `json:"labs_count"`
	RequiredLabsCount int64             `json:"required_labs_count"`
	DebtorsCount      int64             `json:"debtors_count"`
	FinalReadyCount   int64             `json:"final_ready_count"`
	Average           *json.Number      `json:"average"`
	Distribution      gradeDistribution `json:"distribution"`
}

type labStatistics struct {
	LabID         int64        `json:"lab_id"`
	SubjectID     int64        `json:"subject_id"`
	GroupID       int64        `json:"group_id"`
	StudentsCount int64        `json:"students_count"`
	GradedCount   int64        `json:"graded_count"`
	PassedCount   int64        `json:"passed_count"`
	MissingCount  int64        `json:"missing_count"`
	FailedCount   int64        `json:"failed_count"`
	Average       *json.Number `json:"average"`
}

// Keep ratios exact until the final positive half-up rounding. In particular,
// numeric division and averaging displayed student summaries can both move a
// result across a half-cent boundary.
func statisticsAverage(sum *big.Rat, count int64) *json.Number {
	if count == 0 {
		return nil
	}
	scaled := new(big.Rat).Mul(sum, big.NewRat(100, count))
	scaled.Add(scaled, big.NewRat(1, 2))
	cents := new(big.Int).Quo(scaled.Num(), scaled.Denom()).Int64()
	value := json.Number(fmt.Sprintf("%d.%02d", cents/100, cents%100))
	return &value
}

func readStatistics(ctx context.Context, tx pgx.Tx, uid int64, root bool) ([]gradeStatistics, []labStatistics, error) {
	boards := []gradeStatistics{}
	labs := []labStatistics{}
	var allowed bool
	if err := tx.QueryRow(ctx, `SELECT $2 OR teacher FROM users WHERE id=$1`, uid, root).Scan(&allowed); err != nil {
		return nil, nil, err
	}
	if !allowed {
		return boards, labs, nil
	}

	// LEFT JOIN retains active labs with no roster. Count users, not the synthetic
	// empty-join row; grades belonging to former group members do not participate.
	rows, err := tx.Query(ctx, `SELECT l.id,l.subject_id,l.group_id,l.required,
  COUNT(u.id),COUNT(g.value),COUNT(*) FILTER (WHERE g.value>=3),
  COUNT(u.id) FILTER (WHERE g.value IS NULL),
  COUNT(*) FILTER (WHERE g.value=2),COUNT(*) FILTER (WHERE g.value=3),
  COUNT(*) FILTER (WHERE g.value=4),COUNT(*) FILTER (WHERE g.value=5),
  COALESCE(SUM(g.value),0)::bigint
 FROM labs l LEFT JOIN users u ON u.group_id=l.group_id
 LEFT JOIN grades g ON g.lab_id=l.id AND g.student_id=u.id
 WHERE NOT l.archived
 GROUP BY l.id ORDER BY l.group_id,l.subject_id,l.id`)
	if err != nil {
		return nil, nil, err
	}
	type boardKey struct{ subject, group int64 }
	indexes := map[boardKey]int{}
	for rows.Next() {
		var l labStatistics
		var required bool
		var three, four, five, sum int64
		if err = rows.Scan(&l.LabID, &l.SubjectID, &l.GroupID, &required, &l.StudentsCount, &l.GradedCount, &l.PassedCount, &l.MissingCount, &l.FailedCount, &three, &four, &five, &sum); err != nil {
			rows.Close()
			return nil, nil, err
		}
		l.Average = statisticsAverage(big.NewRat(sum, 1), l.GradedCount)
		labs = append(labs, l)
		key := boardKey{l.SubjectID, l.GroupID}
		index, exists := indexes[key]
		if !exists {
			index = len(boards)
			indexes[key] = index
			boards = append(boards, gradeStatistics{SubjectID: l.SubjectID, GroupID: l.GroupID, StudentsCount: l.StudentsCount})
		}
		b := &boards[index]
		b.LabsCount++
		if required {
			b.RequiredLabsCount++
		}
		b.Distribution.Missing += l.MissingCount
		b.Distribution.Two += l.FailedCount
		b.Distribution.Three += three
		b.Distribution.Four += four
		b.Distribution.Five += five
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}

	rows, err = tx.Query(ctx, gradingCTE+`
 SELECT subject_id,group_id,numerator::text,denominator::text,
 required_passed<required_total,final_hint IS NOT NULL FROM summaries`, uid, root)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	sums := make([]big.Rat, len(boards))
	counts := make([]int64, len(boards))
	for rows.Next() {
		var subject, group int64
		var numerator, denominator *string
		var debtor, ready bool
		if err = rows.Scan(&subject, &group, &numerator, &denominator, &debtor, &ready); err != nil {
			return nil, nil, err
		}
		index := indexes[boardKey{subject, group}]
		b := &boards[index]
		if debtor {
			b.DebtorsCount++
		}
		if ready {
			b.FinalReadyCount++
		}
		if denominator == nil {
			continue
		}
		n, okN := new(big.Rat).SetString(*numerator)
		d, okD := new(big.Rat).SetString(*denominator)
		if !okN || !okD || d.Sign() <= 0 {
			return nil, nil, fmt.Errorf("invalid grading totals for subject %d group %d", subject, group)
		}
		sums[index].Add(&sums[index], new(big.Rat).Quo(n, d))
		counts[index]++
	}
	if err = rows.Err(); err != nil {
		return nil, nil, err
	}
	for i := range boards {
		boards[i].Average = statisticsAverage(&sums[i], counts[i])
	}
	return boards, labs, nil
}
