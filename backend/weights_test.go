package main

import (
	"strings"
	"testing"
)

func TestWeightDecimalValidation(t *testing.T) {
	for _, text := range []string{
		"1", "1000000", "1000000.000000000000000000000", "999999.999999999999999999999",
		"0.500000000000000000001", "0.499999999999999999999", "5e-324", "1e-1000", "1e-16383",
		"0." + strings.Repeat("0", 16382) + "1", "1e+0000000000000000000000000000000000000000000000000000000001",
	} {
		t.Run("valid/"+text[:min(len(text), 60)], func(t *testing.T) {
			if !validWeight(text) {
				t.Fatal("valid exact decimal rejected")
			}
		})
	}
	for _, text := range []string{
		"", "0", "0.0", "-0", "-1", "1000000.00000000001", "1000000.0000000000000000000001",
		"NaN", "Infinity", "-Infinity", "1/2", "0x1p0", "+1", "01", ".1", "1.", "1_0", " 1", "1 ",
		"1e", "1e+", "1e309", "1e131072", "1e131073", "1e-16384", "1.0e-16383",
		"1e9999999999999999999999999999999999999999999", "1e-9999999999999999999999999999999999999999999",
		"0e9999999999999999999999999999999999999999999",
		"0." + strings.Repeat("0", 16383) + "1", "0." + strings.Repeat("1", 32768),
	} {
		t.Run("invalid/"+text[:min(len(text), 60)], func(t *testing.T) {
			if validWeight(text) {
				t.Fatal("invalid decimal accepted")
			}
		})
	}
}
