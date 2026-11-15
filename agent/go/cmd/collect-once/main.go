// collect-once: run every Linux collector twice (to get rates) and print the result. Development aid.
package main

import (
	"fmt"
	"os"
	"time"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/collector/linux"
	"observaone/agent/internal/core"
)

func main() {
	env := &collector.Env{Proc: "/proc", Sys: "/sys", Root: "/", Rates: core.NewRates(), Version: "dev"}
	var out *core.Batch
	for round := 0; round < 2; round++ {
		env.Now = time.Now()
		out = core.NewBatch()
		for _, c := range linux.All() {
			b := core.NewBatch()
			t := time.Now()
			err := c.Collect(env, b)
			st := collector.Classify(err)
			if err == nil {
				out.Merge(b)
			}
			fmt.Fprintf(os.Stderr, "round %d %-10s %-11s %4dus %d samples %s\n", round, c.Name(), st.Status, time.Since(t).Microseconds(), b.Len(), st.Error)
		}
		for _, n := range env.TakeNotes() {
			fmt.Fprintln(os.Stderr, "note:", n)
		}
		if round == 0 {
			time.Sleep(2 * time.Second)
		}
	}
	fmt.Print(out.Text(0))
}
