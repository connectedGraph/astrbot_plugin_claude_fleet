// Package ocrcli — OCR / PDF-to-Markdown CLI.
//
// Thin Go wrapper around the tx glm-ocr proxy (GLM layout_parsing). Reads a
// local PDF/image, posts it as base64, and prints the extracted Markdown (or
// the raw JSON with --json). Zero runtime deps; cross-compiles to static
// binaries like cloudtex.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultEndpoint = "https://6767.chat/api/glm-ocr"
	maxPDFBytes     = 50 << 20 // 50 MiB
	maxImageBytes   = 10 << 20 // 10 MiB
)

type result struct {
	Content   []resultContent `json:"content"`
	Usage     map[string]any  `json:"usage"`
	RequestID string          `json:"request_id"`
}

type resultContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func main() {
	var (
		endpoint   = flag.String("endpoint", defaultEndpoint, "glm-ocr proxy URL")
		out        = flag.String("out", "", "write extracted text to this file (default: stdout)")
		jsonOut    = flag.Bool("json", false, "print the full upstream JSON instead of text")
		pageRange  = flag.String("pages", "", "page range, e.g. 1-3 or 2 (PDF only)")
		startPage  = flag.Int("start-page", 0, "start page (1-based)")
		endPage    = flag.Int("end-page", 0, "end page (1-based)")
		timeoutSec = flag.Int("timeout", 180, "upstream timeout in seconds")
		proxy      = flag.String("proxy", "", "HTTP(S) proxy, e.g. http://127.0.0.1:7890 (glm-ocr runs mainland-direct; usually empty)")
		verbose    = flag.Bool("verbose", false, "print request/response diagnostics to stderr")
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: ocrcli [flags] <input.pdf|input.png|input.jpg>\n\n")
		fmt.Fprintf(os.Stderr, "Extract text from a PDF or image via the tx glm-OCR proxy.\n")
		fmt.Fprintf(os.Stderr, "Output is Markdown to stdout unless --out is set.\n\nFlags:\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(2)
	}
	input := flag.Arg(0)
	data, err := os.ReadFile(input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: cannot read %s: %v\n", input, err)
		os.Exit(2)
	}

	kind := detectKind(data)
	limit := maxImageBytes
	if kind == "pdf" {
		limit = maxPDFBytes
	}
	if len(data) > limit {
		fmt.Fprintf(os.Stderr, "error: %s too large (%d bytes > %d)\n", kind, len(data), limit)
		os.Exit(2)
	}

	// Page range is PDF-only.
	startP, endP := *startPage, *endPage
	if *pageRange != "" {
		parts := strings.SplitN(*pageRange, "-", 2)
		fmt.Sscanf(strings.TrimSpace(parts[0]), "%d", &startP)
		if len(parts) > 1 {
			fmt.Sscanf(strings.TrimSpace(parts[1]), "%d", &endP)
		} else {
			endP = startP
		}
	}

	client := &http.Client{
		Timeout: time.Duration(*timeoutSec) * time.Second,
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
		},
	}
	if *proxy != "" {
		client.Transport = &http.Transport{Proxy: http.ProxyURL(mustParseURL(*proxy))}
	}

	body, contentType, err := buildRequest(input, data, kind, startP, endP)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(2)
	}

	if *verbose {
		fmt.Fprintf(os.Stderr, "[ocrcli] POST %s (%d bytes, %s)\n", *endpoint, len(body), contentType)
	}

	req, err := http.NewRequest(http.MethodPost, *endpoint, bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(2)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("User-Agent", "ocrcli/1.0")

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: request failed: %v\n", err)
		os.Exit(2)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: read response: %v\n", err)
		os.Exit(2)
	}

	if resp.StatusCode != http.StatusOK {
		var apiErr struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(respBody, &apiErr)
		if apiErr.Error.Message != "" {
			fmt.Fprintf(os.Stderr, "error: %s\n", apiErr.Error.Message)
		} else {
			fmt.Fprintf(os.Stderr, "error: HTTP %d: %s\n", resp.StatusCode, strings.TrimSpace(string(respBody)))
		}
		os.Exit(1)
	}

	if *jsonOut {
		os.Stdout.Write(respBody)
		return
	}

	// Extract md_results-style text from the upstream response. GLM returns
	// content[] blocks; md_results text may live in content[].text and/or a
	// top-level md_results string.
	text := extractMarkdown(respBody)
	if text == "" {
		// Fall back to the raw body if the shape differs from expectation.
		fmt.Fprintf(os.Stderr, "warning: no Markdown text found in response; run with --json to inspect\n")
		os.Exit(3)
	}

	if *out != "" {
		if err := os.WriteFile(*out, []byte(text), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "error: write %s: %v\n", *out, err)
			os.Exit(2)
		}
		return
	}
	fmt.Print(text)
}

// detectKind sniffs file magic: %PDF / JPEG / PNG.
func detectKind(data []byte) string {
	if len(data) >= 4 && data[0] == '%' && data[1] == 'P' && data[2] == 'D' && data[3] == 'F' {
		return "pdf"
	}
	if len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		return "jpeg"
	}
	if len(data) >= 8 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G' {
		return "png"
	}
	return "unknown"
}

// buildRequest returns the HTTP body and Content-Type. For small inputs we
// use JSON+base64; for multipart we send the raw file (server detects type).
func buildRequest(input string, data []byte, kind string, startP, endP int) ([]byte, string, error) {
	type payload struct {
		Model         string `json:"model"`
		File          string `json:"file"`
		StartPageID   int    `json:"start_page_id,omitempty"`
		EndPageID     int    `json:"end_page_id,omitempty"`
		ReturnCropImg bool   `json:"return_crop_images,omitempty"`
		NeedLayoutViz bool   `json:"need_layout_visualization,omitempty"`
	}
	// Prefer JSON+base64 for files up to ~20 MiB; above that, multipart to
	// avoid an extra base64 expansion in the JSON body.
	if len(data) <= 20<<20 {
		p := payload{Model: "glm-ocr", File: base64.StdEncoding.EncodeToString(data)}
		if kind == "pdf" {
			p.StartPageID = startP
			p.EndPageID = endP
		}
		body, err := json.Marshal(p)
		if err != nil {
			return nil, "", fmt.Errorf("marshal request: %w", err)
		}
		return body, "application/json", nil
	}

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile("file", filepath.Base(input))
	if err != nil {
		return nil, "", err
	}
	if _, err := fw.Write(data); err != nil {
		return nil, "", err
	}
	_ = w.WriteField("model", "glm-ocr")
	if kind == "pdf" && startP > 0 {
		_ = w.WriteField("start_page_id", fmt.Sprint(startP))
	}
	if kind == "pdf" && endP > 0 {
		_ = w.WriteField("end_page_id", fmt.Sprint(endP))
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), w.FormDataContentType(), nil
}

// extractMarkdown pulls text out of the GLM layout_parsing response.
func extractMarkdown(respBody []byte) string {
	var parsed map[string]any
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return ""
	}
	// md_results as a direct string is the common success shape.
	if s, ok := parsed["md_results"].(string); ok && strings.TrimSpace(s) != "" {
		return s
	}
	// content[] array with text blocks (OpenAI-style).
	if content, ok := parsed["content"].([]any); ok {
		var sb strings.Builder
		for _, c := range content {
			if m, ok := c.(map[string]any); ok {
				if t, ok := m["text"].(string); ok {
					sb.WriteString(t)
				}
			}
		}
		if strings.TrimSpace(sb.String()) != "" {
			return sb.String()
		}
	}
	return ""
}

func mustParseURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}
