ALTER TABLE labs
    ADD COLUMN weight numeric NOT NULL DEFAULT 1,
    ADD COLUMN required boolean NOT NULL DEFAULT true,
    ADD CONSTRAINT labs_weight_valid CHECK (weight > 0 AND weight <= 1000000);
