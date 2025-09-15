// app/api/scrape/route.ts
import { NextResponse } from "next/server";
import { chromium, Browser } from "playwright";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

declare global {
  // persist browser across hot reloads / modules
  var __sagashi_browser: Promise<Browser> | undefined;
}

// single browser (lazy)
const getBrowser = async () => {
  if (!globalThis.__sagashi_browser) {
    globalThis.__sagashi_browser = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return globalThis.__sagashi_browser!;
};

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const url: string = body?.url;
    const opts = body?.options || {}; // { timeout, blockResources, screenshot, postWait, userAgent }

    if (!url) return NextResponse.json({ error: "Missing `url` in request body" }, { status: 400 });
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    const browser = await getBrowser();
    const context = await (await browser).newContext({
      userAgent:
        opts.userAgent ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      viewport: { width: 1200, height: 800 },
    });

    // Optionally block large resources to speed up (images/fonts/stylesheets/media)
    if (opts.blockResources !== false) {
      await context.route("**/*", (route) => {
        const r = route.request();
        const t = r.resourceType();
        if (["image", "media", "font", "stylesheet"].includes(t)) route.abort();
        else route.continue();
      });
    }

    const page = await context.newPage();

    // navigate and wait for network idle; sensible defaults
    const timeout = typeof opts.timeout === "number" ? opts.timeout : 20000;
    const response = await page.goto(url, { waitUntil: "networkidle", timeout }).catch(() => null);

    // give a short extra wait for single-page apps which fetch after idle
    await page.waitForTimeout(typeof opts.postWait === "number" ? opts.postWait : 600);

    const finalUrl = page.url();
    const status = response?.status() ?? 0;
    const html = await page.content();

    // parse and extract with JSDOM + Readability
    const dom = new JSDOM(html, { url: finalUrl });
    const doc = dom.window.document as unknown as Document;

    const reader = new Readability(doc as any);
    const article = reader.parse(); // may be null

    // ✨ FIX START: Clean up the text content for proper spacing and paragraph breaks.
    const rawTextContent = article?.textContent || "";
    const cleanedTextContent = rawTextContent
      .split('\n')                  // 1. Split text into an array of lines
      .map(line => line.trim())     // 2. Trim whitespace from the start and end of each line
      .filter(line => line.length > 0) // 3. Remove any lines that are now empty
      .join('\n\n');                // 4. Join the lines back together with double newlines
    // ✨ FIX END

    const getMeta = (name: string) =>
      doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ||
      doc.querySelector(`meta[property="${name}"]`)?.getAttribute("content") ||
      "";

    const title = (doc.querySelector("title")?.textContent || article?.title || "").trim();
    const description = getMeta("description") || getMeta("og:description") || getMeta("twitter:description");
    const ogImage = getMeta("og:image") || getMeta("twitter:image");
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";

    // JSON-LD structured data
    const jsonLd = Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).map((s) => {
      try {
        return JSON.parse(s.textContent || "");
      } catch {
        return s.textContent || null;
      }
    }).filter(Boolean);

    // links, headings, images (unique, limited)
    const links = Array.from(doc.querySelectorAll("a[href]"))
      .map((a) => (a as HTMLAnchorElement).href)
      .filter(Boolean);
    const uniqueLinks = Array.from(new Set(links)).slice(0, 2000);

    const headings = Array.from(doc.querySelectorAll("h1,h2,h3")).map((h) => ({
      tag: h.tagName,
      text: h.textContent?.trim() ?? "",
    }));

    const images = Array.from(doc.querySelectorAll("img"))
      .map((i) => ({ src: (i as HTMLImageElement).src, alt: i.getAttribute("alt") || "" }))
      .slice(0, 500);

    const mainText = (cleanedTextContent || doc.body?.textContent || "").trim();
    const wordCount = mainText ? mainText.split(/\s+/).filter(Boolean).length : 0;
    const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

    const result: any = {
      url,
      finalUrl,
      status,
      title,
      description,
      canonical,
      ogImage,
      jsonLd,
      article: article
        ? {
            title: article.title,
            excerpt: article.excerpt,
            content: article.content,
            textContent: cleanedTextContent,
          }
        : null,
      links: uniqueLinks,
      headings,
      images,
      wordCount,
      readingTimeMinutes,
      scrapedAt: new Date().toISOString(),
    };

    if (opts.screenshot) {
      // base64 screenshot (optional — can be large)
      const buf = await page.screenshot({ fullPage: true });
      result.screenshot = buf.toString("base64");
      result.screenshotMime = "image/png";
    }

    await page.close();
    await context.close();

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("sagashi error:", err);
    return NextResponse.json({ error: err?.message || "unknown error" }, { status: 500 });
  }
}