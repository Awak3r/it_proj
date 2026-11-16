package main

// Current teachers can read every gradebook. Other group members, including
// former teachers, retain only their own-group read access. All gradebook
// representations share this predicate so role revocation applies consistently.
const visibleLab = `($2 OR
    l.group_id=(SELECT group_id FROM users WHERE id=$1) OR
    (SELECT teacher FROM users WHERE id=$1))`

// DIV computes positive half-up rounding directly from the exact ratio, without
// an intermediate rounded quotient (including at the two-decimal boundary).
const gradingCTE = `WITH totals AS (
    SELECT u.id AS student_id,l.subject_id,l.group_id,
        SUM(l.weight * COALESCE(g.value,2)) FILTER (WHERE l.required OR g.value IS NOT NULL) AS numerator,
        SUM(l.weight) FILTER (WHERE l.required OR g.value IS NOT NULL) AS denominator,
        COUNT(*) FILTER (WHERE l.required)::int AS required_total,
        COUNT(*) FILTER (WHERE l.required AND g.value>=3)::int AS required_passed
    FROM labs l
    JOIN users u ON u.group_id=l.group_id
    LEFT JOIN grades g ON g.lab_id=l.id AND g.student_id=u.id
    WHERE NOT l.archived AND ` + visibleLab + `
    GROUP BY u.id,l.subject_id,l.group_id
), summaries AS (
SELECT totals.*,
    DIV(200*numerator+denominator,2*NULLIF(denominator,0))*0.01 AS average,
    CASE WHEN required_total=required_passed AND denominator>0
        THEN DIV(2*numerator+denominator,2*denominator)::int END AS final_hint
FROM totals
)`

const gradeSummariesSQL = gradingCTE + `
SELECT student_id,subject_id,group_id,average,final_hint,required_total,required_passed
FROM summaries ORDER BY group_id,subject_id,student_id`
