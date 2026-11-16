package main

import (
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

var decimalWeight = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

func validWeight(text string) bool {
	// Match the JSON number grammar even for internal callers. Rat.SetString
	// alone also accepts fractions, nondecimal bases, and other non-JSON forms.
	if len(text) > 32768 || !decimalWeight.MatchString(text) {
		return false
	}
	mantissa := text
	var exponent int64
	if i := strings.IndexAny(text, "eE"); i >= 0 {
		mantissa = text[:i]
		var err error
		exponent, err = strconv.ParseInt(text[i+1:], 10, 32)
		if err != nil {
			return false
		}
	}
	// Bound expansion BEFORE constructing a rational. These are PostgreSQL's
	// unconstrained numeric limits, not an application decimal precision cap.
	// Also reject excessive input scale instead of letting SQL round or fail.
	fractionDigits := 0
	if i := strings.IndexByte(mantissa, '.'); i >= 0 {
		fractionDigits = len(mantissa) - i - 1
		mantissa = mantissa[:i]
	}
	integerDigits := len(strings.TrimPrefix(mantissa, "-"))
	if exponent < -16383 || exponent > 131072 ||
		int64(fractionDigits)-exponent > 16383 || int64(integerDigits)+exponent > 131072 {
		return false
	}
	value, ok := new(big.Rat).SetString(text)
	return ok && value.Sign() > 0 && value.Cmp(big.NewRat(1000000, 1)) <= 0
}
