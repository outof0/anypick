package main

import (
	"fmt"
	"io"

	"github.com/outof0/anypick/go/internal/i18n"
)

func cliPrint(args ...any) (int, error) {
	return fmt.Print(localizeCLI(fmt.Sprint(args...)))
}

func cliPrintln(args ...any) (int, error) {
	return fmt.Print(localizeCLI(fmt.Sprintln(args...)))
}

func cliPrintlnRaw(args ...any) (int, error) {
	return fmt.Println(args...)
}

func cliPrintf(format string, args ...any) (int, error) {
	return fmt.Printf(localizeCLI(format), args...)
}

func cliFprintln(w io.Writer, args ...any) (int, error) {
	return fmt.Fprint(w, localizeCLI(fmt.Sprintln(args...)))
}

func cliFprintf(w io.Writer, format string, args ...any) (int, error) {
	return fmt.Fprintf(w, localizeCLI(format), args...)
}

func localizeCLI(text string) string {
	// JSON output is a stable machine interface. Its keys, values, and even
	// error envelopes must not change with the user's display locale.
	if globals.JSON {
		return text
	}
	return i18n.Text(text)
}
