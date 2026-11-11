#!/usr/bin/env python3
"""Eudaimon news feed for the Dealer Terminal: crypto + macro headlines → data/news.json.

RSS sources (no keys). Run hourly by .github/workflows/news.yml. Standard library only.
Each item gets asset tags (BTC / ETH / MACRO) and a simple keyword tone score; the tone
is a word count, not a model, and the page says so.
"""
import json, os, re, subprocess, sys, html
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "news.json")
GN = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q="
FEEDS = [
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("Cointelegraph", "https://cointelegraph.com/rss"),
    ("Decrypt", "https://decrypt.co/feed"),
    ("The Block", "https://www.theblock.co/rss.xml"),
    ("Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml"),
    ("Google News", GN + "bitcoin+when:2d"),
    ("Google News", GN + "ethereum+when:2d"),
    ("Google News", GN + "%22Federal+Reserve%22+OR+FOMC+OR+inflation+when:2d"),
    ("Google News", GN + "crypto+ETF+OR+SEC+crypto+when:2d"),
]
TAGS = {
    "BTC": re.compile(r"\b(bitcoin|btc|saylor|microstrategy|strategy inc|ibit)\b", re.I),
    "ETH": re.compile(r"\b(ethereum|ether|eth|vitalik|staking)\b", re.I),
    "MACRO": re.compile(r"\b(fed|fomc|powell|inflation|cpi|pce|rates?|treasur(y|ies)|yields?|tariffs?|jobs|payrolls|recession|dollar|sec|etfs?|congress|white house)\b", re.I),
}
BULL = re.compile(r"\b(surge[sd]?|soar(s|ed)?|rall(y|ies|ied)|jump(s|ed)?|record|all-time high|inflows?|approv(e|es|ed|al)|gain(s|ed)?|ris(e|es|ing)|rose|bull(ish)?|breakout|climb(s|ed)?|rebound(s|ed)?|buy(s|ing)?|adopt(s|ion)?|cut(s)? rates?)\b", re.I)
BEAR = re.compile(r"\b(plunge[sd]?|crash(es|ed)?|fall(s|ing)?|fell|drop(s|ped)?|slump(s|ed)?|outflows?|hack(ed)?|exploit(ed)?|lawsuit|sue[sd]?|sell-?off|liquidat\w*|ban(s|ned)?|reject(s|ed)?|bear(ish)?|declin(e|es|ed)|fear|tumbl(e|es|ed)|sink(s)?|sank|hike[sd]?|warn(s|ing)?)\b", re.I)


def get(url):
    return subprocess.run(["curl", "-sfL", "-m", "40", url], capture_output=True, check=True).stdout


def clean(s):
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return re.sub(r"\s+", " ", s).strip()


def parse(src, raw):
    root = ET.fromstring(raw.lstrip(b"\xef\xbb\xbf"))
    for it in root.iter("item"):
        title = clean(it.findtext("title"))
        link = (it.findtext("link") or "").strip()
        pub = it.findtext("pubDate") or ""
        source = src
        s_el = it.find("source")
        if src == "Google News" and s_el is not None and s_el.text:
            source = s_el.text.strip()
            title = re.sub(r"\s+-\s+" + re.escape(source) + r"$", "", title)
        try:
            t = parsedate_to_datetime(pub).astimezone(timezone.utc)
        except Exception:
            continue
        desc = clean(it.findtext("description"))[:280]
        yield {"t": t, "title": title, "link": link, "source": source, "via": src, "desc": desc if src != "Google News" else ""}


def main():
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=72)
    items, seen, errors = [], set(), []
    for src, url in FEEDS:
        try:
            n = 0
            for it in parse(src, get(url)):
                key = re.sub(r"[^a-z0-9]", "", it["title"].lower())[:70]
                if it["t"] < cutoff or it["t"] > now + timedelta(minutes=10) or not it["title"] or key in seen:
                    continue
                seen.add(key)
                text = it["title"] + " " + it["desc"]
                tags = [k for k, rx in TAGS.items() if rx.search(text)]
                if src == "Federal Reserve":
                    tags = sorted(set(tags + ["MACRO"]))
                b, r = len(BULL.findall(it["title"])), len(BEAR.findall(it["title"]))
                it.update(tags=tags, tone=b - r, t=it["t"].strftime("%Y-%m-%dT%H:%M:%SZ"))
                items.append(it)
                n += 1
            print(f"{src:16s} +{n}  {url[:70]}")
        except Exception as e:
            errors.append(f"{src}: {e}")
    items.sort(key=lambda x: x["t"], reverse=True)
    items = [i for i in items if i["tags"]][:300]
    data = {"fetched": now.strftime("%Y-%m-%dT%H:%MZ"), "count": len(items), "items": items, "errors": errors}
    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print("wrote", OUT, os.path.getsize(OUT), "bytes;", len(items), "items;", errors)
    return 0 if items else 1


if __name__ == "__main__":
    sys.exit(main())
