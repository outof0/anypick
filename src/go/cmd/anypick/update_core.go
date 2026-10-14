package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/cli"
	"github.com/outof0/anypick/go/internal/update"
)

// cmdUpdateCore is the bridge the desktop shells use for in-app updates:
// `update check` and `update download`, each printing NDJSON StatusDTO lines
// (with --json). It is a one-shot process, so it needs no desktop-protocol
// capability negotiation.
func cmdUpdateCore(ctx context.Context, verb string, args []string) int {
	if cli.WantsHelp(args) {
		return cmdUpdate(ctx, nil, []string{"--help"})
	}
	current := packageVersion()
	asJSON := wantJSON(args)
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
		case "--current":
			if i+1 >= len(args) || args[i+1] == "" {
				fmt.Fprintln(os.Stderr, "--current needs a version")
				return int(anyerr.InvalidUsage)
			}
			current = args[i+1]
			i++
		default:
			fmt.Fprintf(os.Stderr, "unknown flag %q for update %s\n", args[i], verb)
			return int(anyerr.InvalidUsage)
		}
	}
	env := update.OSEnv{}
	cacheDir := ""
	if base, err := os.UserCacheDir(); err == nil {
		cacheDir = filepath.Join(base, "AnyPick", "update")
	}
	r := &update.Runner{
		Checker: &update.Checker{
			Fetcher: &update.GitHubFetcher{Env: env},
			Clock:   update.RealClock{},
			Env:     env,
			GOOS:    runtime.GOOS,
			GOARCH:  runtime.GOARCH,
		},
		Env:      env,
		CacheDir: cacheDir,
	}
	if asJSON {
		r.Emit = func(d update.StatusDTO) { _ = update.WriteStatusLine(os.Stdout, d) }
	}
	ch := update.DetectChannel(update.DetectOpts{Env: env})
	timeout := 20 * time.Second
	if verb == "download" {
		timeout = 15 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var final update.StatusDTO
	if verb == "download" {
		final = r.Download(ctx, current, ch)
	} else {
		final = r.Check(ctx, current, ch)
	}
	if !asJSON {
		msg := final.Message
		if msg == "" {
			msg = final.Lead
		}
		fmt.Printf("%s: %s\n", final.Kind, msg)
		if final.Latest != "" && final.Kind != "upToDate" {
			fmt.Printf("latest: %s\n", final.Latest)
		}
		if final.Command != "" {
			fmt.Println(final.Command)
		}
		if final.FilePath != "" {
			fmt.Println(final.FilePath)
		}
	}
	return int(anyerr.Success)
}
