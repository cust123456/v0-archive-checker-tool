import { type NextRequest, NextResponse } from "next/server"
import dns from 'dns/promises';   // ← Thêm dòng này
export const runtime = 'nodejs';

// Hàm timeout (giữ nguyên nhưng mình chỉnh nhỏ hơn)
function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
    fetch(url, options)
      .then((response) => { clearTimeout(timer); resolve(response); })
      .catch((error) => { clearTimeout(timer); reject(error); });
  });
}

// Kiểm tra DNS nhanh
async function isDomainResolvable(domain: string): Promise<boolean> {
  try {
    await dns.resolve4(domain);
    return true;
  } catch {
    try {
      await dns.resolve6(domain);
      return true;
    } catch {
      return false;
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const { domain } = await request.json();
    if (!domain) {
      return NextResponse.json({ error: "Domain is required" }, { status: 400 });
    }

    console.log("[v0] Checking domain:", domain);

    // === THÊM PHẦN NÀY: Kiểm tra DNS trước ===
    if (!(await isDomainResolvable(domain))) {
      console.log(`[v0] DNS không tồn tại → ${domain}`);
      return NextResponse.json({
        success: true,
        hasArchive: false,
      });
    }
    // =========================================

    // Ưu tiên Availability API (nhẹ và nhanh hơn CDX)
    try {
      const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(domain)}`;
      console.log("[v0] Fetching Availability:", availabilityUrl);

      const availabilityResponse = await fetchWithTimeout(
        availabilityUrl,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "application/json",
          },
        },
        6000   // giảm xuống 6 giây
      );

      if (availabilityResponse.ok) {
        const data = await availabilityResponse.json();
        if (data.archived_snapshots?.closest) {
          const ts = data.archived_snapshots.closest.timestamp;
          const year = Number.parseInt(ts.substring(0, 4));
          return NextResponse.json({
            success: true,
            hasArchive: true,
            firstYear: year,
            lastYear: year,
            years: 1,
            totalSnapshots: 1,
          });
        }
      }
    } catch (e) {
      console.log("[v0] Availability failed, trying CDX...");
    }

    // Nếu Availability fail mới gọi CDX (với limit nhỏ)
    try {
      const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&limit=5&fl=timestamp`;
      const cdxResponse = await fetchWithTimeout(cdxUrl, { headers: { "User-Agent": "Mozilla/5.0..." } }, 7000);

      if (cdxResponse.ok) {
        const text = await cdxResponse.text();
        if (!text || text.trim() === "[]") {
          return NextResponse.json({ success: true, hasArchive: false });
        }

        const cdxData = JSON.parse(text);
        if (!cdxData || cdxData.length <= 1) {
          return NextResponse.json({ success: true, hasArchive: false });
        }

        // Parse years...
        const snapshots = cdxData.slice(1);
        const years = snapshots.map((s: string[]) => Number.parseInt(s[0].substring(0, 4)));
        const uniqueYears = [...new Set(years)].sort();

        return NextResponse.json({
          success: true,
          hasArchive: true,
          firstYear: uniqueYears[0],
          lastYear: uniqueYears[uniqueYears.length - 1],
          years: uniqueYears.length,
          totalSnapshots: snapshots.length,
        });
      }
    } catch (cdxError) {
      console.log("[v0] CDX also failed");
    }

    // Nếu cả 2 đều fail
    return NextResponse.json({ success: true, hasArchive: false });

  } catch (error) {
    console.error("[v0] Error:", error);
    return NextResponse.json({ success: false, error: "Failed" }, { status: 500 });
  }
}
