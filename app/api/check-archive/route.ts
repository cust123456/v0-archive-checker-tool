import { type NextRequest, NextResponse } from "next/server"

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    fetch(url, options)
      .then((response) => {
        clearTimeout(timer)
        resolve(response)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

export async function POST(request: NextRequest) {
  try {
    const { domain } = await request.json()

    if (!domain) {
      return NextResponse.json({ error: "Domain is required" }, { status: 400 })
    }

    console.log("[v0] Checking domain:", domain)

    try {
      const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&fl=timestamp`

      console.log("[v0] Fetching CDX data from:", cdxUrl)

      const cdxResponse = await fetchWithTimeout(
        cdxUrl,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json",
          },
        },
        7000,
      )

      if (cdxResponse.ok) {
        const contentType = cdxResponse.headers.get("content-type")
        const responseText = await cdxResponse.text()

        if (!responseText || !contentType?.includes("application/json")) {
          console.log("[v0] CDX returned non-JSON or empty response for domain:", domain)
          throw new Error("CDX returned non-JSON response")
        }

        let cdxData
        try {
          cdxData = JSON.parse(responseText)
        } catch (parseError) {
          console.warn("[v0] Failed to parse CDX response as JSON:", parseError)
          throw parseError
        }

        console.log("[v0] CDX response length:", cdxData?.length)

        if (!cdxData || cdxData.length <= 1) {
          console.log("[v0] No archive found in CDX for domain:", domain)
          return NextResponse.json({
            success: true,
            hasArchive: false,
          })
        }

        const snapshots = cdxData.slice(1)

        const years = snapshots.map((snapshot: string[]) => {
          const ts = snapshot[0]
          return Number.parseInt(ts.substring(0, 4))
        })

        const uniqueYears = [...new Set(years)].sort()
        const firstYear = uniqueYears[0]
        const lastYear = uniqueYears[uniqueYears.length - 1]

        console.log(
          "[v0] CDX success - Snapshots:",
          snapshots.length,
          "Years:",
          uniqueYears.length,
          "First:",
          firstYear,
          "Last:",
          lastYear,
        )

        return NextResponse.json({
          success: true,
          hasArchive: true,
          firstYear,
          lastYear,
          years: uniqueYears.length,
          totalSnapshots: snapshots.length,
        })
      }

      console.warn("[v0] CDX API returned non-OK status:", cdxResponse.status)
    } catch (cdxError) {
      const errorMsg = cdxError instanceof Error ? cdxError.message : "Unknown error"
      console.log("[v0] CDX API unavailable for this domain:", errorMsg)
    }

    console.log("[v0] Falling back to Availability API")

    try {
      const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(domain)}`
      console.log("[v0] Fetching from:", availabilityUrl)

      const availabilityResponse = await fetchWithTimeout(
        availabilityUrl,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json",
          },
        },
        8000,
      )

      console.log("[v0] Availability response status:", availabilityResponse.status)

      if (!availabilityResponse.ok) {
        console.error("[v0] Availability API failed with status:", availabilityResponse.status)
        throw new Error(`API request failed with status ${availabilityResponse.status}`)
      }

      const availabilityData = await availabilityResponse.json()
      console.log("[v0] Availability data:", JSON.stringify(availabilityData))

      if (!availabilityData.archived_snapshots?.closest) {
        console.log("[v0] No archive found for domain:", domain)
        return NextResponse.json({
          success: true,
          hasArchive: false,
        })
      }

      const closest = availabilityData.archived_snapshots.closest
      const timestamp = closest.timestamp
      const year = Number.parseInt(timestamp.substring(0, 4))

      console.log("[v0] Archive found via Availability API, year:", year)

      return NextResponse.json({
        success: true,
        hasArchive: true,
        firstYear: year,
        lastYear: year,
        years: 1,
        totalSnapshots: 1,
      })
    } catch (availabilityError) {
      const errorMsg = availabilityError instanceof Error ? availabilityError.message : "Unknown error"
      console.log("[v0] Availability API also failed:", errorMsg)
      console.log("[v0] Both APIs failed, returning not found for domain:", domain)

      return NextResponse.json({
        success: true,
        hasArchive: false,
      })
    }
  } catch (error) {
    console.error("[v0] Archive check error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to check archive",
      },
      { status: 500 },
    )
  }
}
