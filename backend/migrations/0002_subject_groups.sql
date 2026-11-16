CREATE TABLE subject_groups (
    subject_id bigint NOT NULL REFERENCES subjects(id),
    group_id bigint NOT NULL REFERENCES groups(id),
    PRIMARY KEY (subject_id, group_id)
);

INSERT INTO subject_groups(subject_id, group_id)
SELECT subject_id, group_id FROM labs
UNION
SELECT e.subject_id, eg.group_id
FROM event_groups eg JOIN events e ON e.id = eg.event_id;
