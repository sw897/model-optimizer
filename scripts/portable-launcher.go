package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	root := filepath.Dir(executable)
	entry := "opt-cli.js"
	if strings.EqualFold(filepath.Base(executable), "model-lod-worker.exe") {
		entry = "cli.js"
	}
	args := append([]string{filepath.Join(root, "app", "dist", entry)}, os.Args[1:]...)
	command := exec.Command(filepath.Join(root, "runtime", "node.exe"), args...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
