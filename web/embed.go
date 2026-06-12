// Package web embeds the built React UI. Run `npm run build` before
// `go build` so web/dist exists.
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
