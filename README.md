# PrediX — Polymarket Smart Recommendations for Twitter (X)

A Chrome Extension that delivers real-time Polymarket prediction market recommendations on Twitter/X via a two-phase AI matching pipeline.

## Overview

PrediX scans tweets on your timeline, matches them against Polymarket prediction markets using an LLM-enhanced ranking system, and injects recommendation buttons directly into tweets. Click any button to open a sidebar with detailed market data, live pricing, order books, and one-click trading — all without leaving Twitter.

### Features

- **Real-time tweet scanning** as you scroll
- **Two-phase matching** — fast keyword/embedding match + async LLM rerank
- **Client-side ML preprocessing** — NER + OCR run locally
- **Live market data** — real-time prices, volume, order books, price history
- **Full trading support** — Buy Yes/No, limit orders, portfolio tracking
- **Continuously learning** — user feedback personalizes future recommendations

## Load in Chrome

> This repository already contains the built extension — no build step required.

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository's root folder (the one containing `manifest.json`)
5. Open `https://x.com`
