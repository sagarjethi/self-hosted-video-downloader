// Downcut — self-hosted YouTube & Instagram downloader with an online video
// cutter. Single binary: Go server + embedded React UI, wrapping yt-dlp + ffmpeg.
package main

import (
	"cmp"
	"context"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/sagarjethi/self-hosted-video-downloader/internal/api"
	"github.com/sagarjethi/self-hosted-video-downloader/internal/jobs"
	"github.com/sagarjethi/self-hosted-video-downloader/internal/ratelimit"
	"github.com/sagarjethi/self-hosted-video-downloader/web"
)

func main() {
	port := cmp.Or(os.Getenv("PORT"), "8787")

	ui, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		log.Fatalf("embedded UI missing (run `npm run build` before `go build`): %v", err)
	}

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           api.New(jobs.NewStore(), ratelimit.New(), ui).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: file responses can stream for many minutes.
	}

	go func() {
		log.Printf("[downloader] listening on http://localhost:%s", port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
}
