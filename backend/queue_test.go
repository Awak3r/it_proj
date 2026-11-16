package main

import (
	"reflect"
	"testing"
)

func ids(v []entry) []int64 {
	o := []int64{}
	for _, x := range v {
		o = append(o, x.ID)
	}
	return o
}
func TestQueueInsertion(t *testing.T) {
	tests := []struct {
		name  string
		ev    event
		items []entry
		want  []int64
	}{
		{"score ascending", event{Strategy: "asc"}, []entry{{ID: 1, Score: 1}, {ID: 2, Score: 5}}, []int64{1, 3, 2}},
		{"score descending", event{Strategy: "desc"}, []entry{{ID: 2, Score: 5}, {ID: 1, Score: 1}}, []int64{2, 3, 1}},
		{"ties stable", event{Strategy: "asc"}, []entry{{ID: 1, Score: 3}, {ID: 2, Score: 3}}, []int64{1, 2, 3}},
		{"new before skipped", event{Strategy: "fifo"}, []entry{{ID: 1}, {ID: 2, Skipped: true}}, []int64{1, 3, 2}},
		{"root override prepends", event{Strategy: "asc", Manual: true}, []entry{{ID: 1, Score: 1}, {ID: 2, Score: 5}}, []int64{3, 1, 2}},
		{"random overrides root", event{Strategy: "random", Manual: true, Shuffled: true}, []entry{{ID: 1}, {ID: 2, Skipped: true}}, []int64{1, 2, 3}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ids(insertEntry(tt.items, entry{ID: 3, Score: 3}, tt.ev))
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v want %v", got, tt.want)
			}
		})
	}
}
