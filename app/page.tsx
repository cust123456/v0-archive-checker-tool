"use client"

import { useState } from "react"
import { Zap, BarChart3, Info, Download, FileText, ChevronDown, ChevronUp, Loader2, Clock, Filter } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const SAMPLE_DOMAINS = `example.com
test.com
sample.com`

interface ScanResult {
  domain: string
  status: "complete" | "error" | "not-found" | "checking" | "pending"
  years: number
  firstYear: string
  lastYear: string
  totalSnapshots: number
  timeMs: number
}

function isValidDomain(domain: string): boolean {
  // Basic domain validation regex
  const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i
  return domainRegex.test(domain)
}

function cleanAndDeduplicateDomains(input: string): { cleaned: string; removed: number; duplicates: number } {
  const lines = input
    .split("\n")
    .map((d) => d.trim())
    .filter((d) => d.length > 0)

  const validDomains: string[] = []
  const seen = new Set<string>()
  let invalidCount = 0
  let duplicateCount = 0

  for (const line of lines) {
    if (!isValidDomain(line)) {
      invalidCount++
      continue
    }

    const lowerDomain = line.toLowerCase()
    if (seen.has(lowerDomain)) {
      duplicateCount++
      continue
    }

    seen.add(lowerDomain)
    validDomains.push(line)
  }

  return {
    cleaned: validDomains.join("\n"),
    removed: invalidCount,
    duplicates: duplicateCount,
  }
}

async function checkArchive(domain: string): Promise<Omit<ScanResult, "domain">> {
  const startTime = Date.now()

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Request timeout")), 15000) // 15 second timeout
    })

    const checkPromise = fetch("/api/check-archive", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domain }),
    })

    const response = await Promise.race([checkPromise, timeoutPromise])
    const data = await response.json()
    const timeMs = Date.now() - startTime

    if (!response.ok || !data.success) {
      return {
        status: "error",
        years: 0,
        firstYear: "-",
        lastYear: "-",
        totalSnapshots: 0,
        timeMs,
      }
    }

    if (data.hasArchive) {
      return {
        status: "complete",
        years: data.years || 0,
        firstYear: data.firstYear?.toString() || "-",
        lastYear: data.lastYear?.toString() || "-",
        totalSnapshots: data.totalSnapshots || 0,
        timeMs,
      }
    } else {
      return {
        status: "not-found",
        years: 0,
        firstYear: "-",
        lastYear: "-",
        totalSnapshots: 0,
        timeMs,
      }
    }
  } catch (error) {
    const timeMs = Date.now() - startTime
    return {
      status: "error",
      years: 0,
      firstYear: "-",
      lastYear: "-",
      totalSnapshots: 0,
      timeMs,
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default function ArchiveChecker() {
  const [domains, setDomains] = useState("")
  const [isScanning, setIsScanning] = useState(false)
  const [results, setResults] = useState<ScanResult[]>([])
  const [isTextareaCollapsed, setIsTextareaCollapsed] = useState(false)
  const [currentBatch, setCurrentBatch] = useState(0)
  const [totalBatches, setTotalBatches] = useState(0)
  const [elapsedTime, setElapsedTime] = useState(0)
  const [percentComplete, setPercentComplete] = useState(0)
  const [filterNotification, setFilterNotification] = useState<string | null>(null)
  const [stats, setStats] = useState({
    completed: 0,
    errors: 0,
    avgTime: 0,
  })

  const loadSampleDomains = () => {
    setDomains(SAMPLE_DOMAINS)
  }

  const cleanDomains = () => {
    const result = cleanAndDeduplicateDomains(domains)
    setDomains(result.cleaned)

    const messages: string[] = []
    if (result.removed > 0) {
      messages.push(`${result.removed} domain không hợp lệ`)
    }
    if (result.duplicates > 0) {
      messages.push(`${result.duplicates} domain trùng lặp`)
    }

    if (messages.length > 0) {
      setFilterNotification(`Đã loại bỏ ${messages.join(" và ")}`)
      setTimeout(() => setFilterNotification(null), 5000)
    } else {
      setFilterNotification("Tất cả domain đều hợp lệ!")
      setTimeout(() => setFilterNotification(null), 3000)
    }
  }

  const startScan = async () => {
    const cleanResult = cleanAndDeduplicateDomains(domains)
    const domainList = cleanResult.cleaned.split("\n").filter((d) => d.trim().length > 0)

    if (cleanResult.removed > 0 || cleanResult.duplicates > 0) {
      setDomains(cleanResult.cleaned)
      const messages: string[] = []
      if (cleanResult.removed > 0) messages.push(`${cleanResult.removed} domain không hợp lệ`)
      if (cleanResult.duplicates > 0) messages.push(`${cleanResult.duplicates} domain trùng lặp`)
      setFilterNotification(`Đã tự động loại bỏ ${messages.join(" và ")}`)
      setTimeout(() => setFilterNotification(null), 5000)
    }

    if (domainList.length === 0) {
      return
    }

    setIsScanning(true)
    setResults([])
    setStats({ completed: 0, errors: 0, avgTime: 0 })
    setCurrentBatch(0)
    setElapsedTime(0)
    setPercentComplete(0)

    const batchSize = 10
    const concurrentChecks = 5
    const totalBatchCount = Math.ceil(domainList.length / batchSize)
    setTotalBatches(totalBatchCount)

    const initialResults: ScanResult[] = domainList.map((domain) => ({
      domain,
      status: "pending",
      years: 0,
      firstYear: "-",
      lastYear: "-",
      totalSnapshots: 0,
      timeMs: 0,
    }))
    setResults(initialResults)

    const scanResults: ScanResult[] = [...initialResults]
    let totalTime = 0
    let errorCount = 0
    const startTime = Date.now()

    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000))
    }, 100)

    for (let i = 0; i < domainList.length; i += batchSize) {
      const batch = domainList.slice(i, i + batchSize)
      const batchNumber = Math.floor(i / batchSize) + 1
      setCurrentBatch(batchNumber)

      // Mark batch as checking
      for (let j = i; j < i + batch.length; j++) {
        scanResults[j].status = "checking"
      }
      setResults([...scanResults])

      for (let batchIndex = 0; batchIndex < batch.length; batchIndex += concurrentChecks) {
        const miniBatch = batch.slice(batchIndex, batchIndex + concurrentChecks)
        const miniBatchPromises = miniBatch.map(async (domain, miniIndex) => {
          const resultIndex = i + batchIndex + miniIndex
          const result = await checkArchive(domain)

          scanResults[resultIndex] = {
            domain,
            status: result.status,
            years: result.years,
            firstYear: result.firstYear,
            lastYear: result.lastYear,
            totalSnapshots: result.totalSnapshots,
            timeMs: result.timeMs,
          }

          totalTime += result.timeMs
          if (result.status === "error") errorCount++

          return result
        })

        await Promise.allSettled(miniBatchPromises)

        const completedCount = scanResults.filter((r) => r.status !== "pending" && r.status !== "checking").length
        setResults([...scanResults])
        setStats({
          completed: completedCount,
          errors: errorCount,
          avgTime: completedCount > 0 ? Math.floor(totalTime / completedCount) : 0,
        })
        setPercentComplete(Math.floor((completedCount / domainList.length) * 100))

        if (batchIndex + concurrentChecks < batch.length || i + batchSize < domainList.length) {
          await delay(100)
        }
      }
    }

    clearInterval(timer)
    setIsScanning(false)
  }

  const cancelScan = () => {
    setIsScanning(false)
    setCurrentBatch(0)
    setTotalBatches(0)
    setElapsedTime(0)
    setPercentComplete(0)
  }

  const exportResults = () => {
    const csv = [
      ["Domain", "Status", "Years", "First Year", "Last Year", "Total Snapshots", "Time (ms)"],
      ...results.map((r) => [r.domain, r.status, r.years, r.firstYear, r.lastYear, r.totalSnapshots, r.timeMs]),
    ]
      .map((row) => row.join(","))
      .join("\n")

    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "archive-scan-results.csv"
    a.click()
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <div className="container mx-auto px-4 py-12 max-w-7xl">
        <div className="text-center mb-12">
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className="relative">
              <Zap className="w-12 h-12 text-blue-500" />
              <div className="absolute inset-0 blur-xl bg-blue-500/30"></div>
            </div>
            <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-400 via-cyan-400 to-blue-500 bg-clip-text text-transparent">
              Archive Checker Pro
            </h1>
          </div>
          <p className="text-lg text-slate-400 max-w-3xl mx-auto mb-3">
            Công cụ kiểm tra lưu trữ domain siêu tốc. Xử lý tới 1000 domain với 10 domain mỗi batch và xử lý song song
            để đạt tốc độ tối đa.
          </p>
          <p className="text-sm text-slate-500 font-medium">
            Tool check archive của <span className="text-blue-400 font-bold">GENO KJC</span>
          </p>
        </div>

        <div className="bg-slate-900/50 backdrop-blur-sm border border-slate-800 rounded-2xl shadow-2xl p-8 mb-8">
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-5 h-5 text-blue-500" />
              <h2 className="text-2xl font-bold text-slate-100">Kiểm Tra Hàng Loạt Nhanh Chóng</h2>
            </div>
            <p className="text-slate-400">
              Quét hiệu suất cao: 10 domain mỗi batch • Xử lý song song • Tối ưu production • Không lỗi tín hiệu
            </p>
          </div>

          <Alert className="mb-6 border-blue-900/50 bg-blue-950/30">
            <Info className="h-4 w-4 text-blue-400" />
            <AlertDescription className="text-blue-300">
              <strong className="font-semibold">Chế Độ Tốc Độ Cao:</strong> Nhập tới 1000 domain để kiểm tra lưu trữ
              siêu nhanh. Tối ưu hóa cho triển khai production với xử lý lỗi nâng cao.
            </AlertDescription>
          </Alert>

          {filterNotification && (
            <Alert className="mb-6 border-green-900/50 bg-green-950/30">
              <Filter className="h-4 w-4 text-green-400" />
              <AlertDescription className="text-green-300">{filterNotification}</AlertDescription>
            </Alert>
          )}

          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-slate-300">
                Danh Sách Domain ({domains.split("\n").filter((d) => d.trim()).length} domain)
              </label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsTextareaCollapsed(!isTextareaCollapsed)}
                className="text-slate-400 hover:text-slate-100 hover:bg-slate-800"
              >
                {isTextareaCollapsed ? (
                  <>
                    <ChevronDown className="w-4 h-4 mr-1" />
                    Mở rộng
                  </>
                ) : (
                  <>
                    <ChevronUp className="w-4 h-4 mr-1" />
                    Thu gọn
                  </>
                )}
              </Button>
            </div>
            {!isTextareaCollapsed && (
              <Textarea
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
                placeholder="Nhập domain (mỗi dòng một domain)..."
                className="h-[280px] font-mono text-sm resize-y overflow-auto bg-slate-950/50 border-slate-800 text-slate-200 placeholder:text-slate-600"
                disabled={isScanning}
              />
            )}
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={startScan}
              disabled={isScanning || !domains.trim()}
              className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 shadow-lg shadow-blue-500/20"
              size="lg"
            >
              <Zap className="w-4 h-4 mr-2" />
              {isScanning ? "Đang Quét..." : "Bắt Đầu Quét Tốc Độ Cao"}
            </Button>
            <Button
              onClick={cleanDomains}
              variant="outline"
              disabled={isScanning || !domains.trim()}
              size="lg"
              className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100 bg-transparent"
            >
              <Filter className="w-4 h-4 mr-2" />
              Lọc & Loại Trùng
            </Button>
            <Button
              onClick={loadSampleDomains}
              variant="outline"
              disabled={isScanning}
              size="lg"
              className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100 bg-transparent"
            >
              <FileText className="w-4 h-4 mr-2" />
              Tải Domain Mẫu
            </Button>
            <Button
              onClick={exportResults}
              variant="outline"
              disabled={results.length === 0}
              size="lg"
              className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100 bg-transparent"
            >
              <Download className="w-4 h-4 mr-2" />
              Xuất Kết Quả
            </Button>
          </div>
        </div>

        {isScanning && (
          <div className="bg-slate-900/50 backdrop-blur-sm border border-slate-800 rounded-2xl shadow-2xl p-6 mb-8">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                <span className="text-lg font-semibold text-slate-100">
                  Đang xử lý batch {currentBatch} / {totalBatches}
                </span>
                <div className="flex items-center gap-2 text-slate-400">
                  <Clock className="w-4 h-4" />
                  <span>{elapsedTime.toFixed(1)}s</span>
                </div>
              </div>
              <Button
                onClick={cancelScan}
                variant="outline"
                size="sm"
                className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100 bg-transparent"
              >
                Hủy Quét
              </Button>
            </div>
            <div className="flex items-center justify-between text-sm text-slate-400">
              <span>10 domain mỗi batch • Xử lý song song • Chế độ tốc độ cao</span>
              <span className="font-semibold text-blue-400">{percentComplete}% hoàn thành</span>
            </div>
          </div>
        )}

        {results.length > 0 && (
          <div className="bg-slate-900/50 backdrop-blur-sm border border-slate-800 rounded-2xl shadow-2xl p-8">
            <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
              <h3 className="text-2xl font-bold text-slate-100">Kết Quả Quét ({results.length} domain)</h3>
              <div className="flex items-center gap-6 text-sm flex-wrap">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  <span className="text-slate-400">
                    Hoàn thành: <strong className="text-slate-200">{stats.completed}</strong>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-red-500"></div>
                  <span className="text-slate-400">
                    Lỗi: <strong className="text-slate-200">{stats.errors}</strong>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                  <span className="text-slate-400">
                    TB: <strong className="text-slate-200">{stats.avgTime}ms</strong>
                  </span>
                </div>
              </div>
            </div>

            <div className="border border-slate-800 rounded-lg overflow-hidden">
              <div className="max-h-[500px] overflow-y-auto">
                <Table>
                  <TableHeader className="bg-slate-950/50 sticky top-0">
                    <TableRow className="border-slate-800 hover:bg-slate-950/50">
                      <TableHead className="font-semibold text-slate-300">Domain</TableHead>
                      <TableHead className="font-semibold text-slate-300">Trạng Thái</TableHead>
                      <TableHead className="font-semibold text-slate-300">Số Năm</TableHead>
                      <TableHead className="font-semibold text-slate-300">Năm Đầu</TableHead>
                      <TableHead className="font-semibold text-slate-300">Năm Cuối</TableHead>
                      <TableHead className="font-semibold text-slate-300">Tổng Snapshot</TableHead>
                      <TableHead className="font-semibold text-slate-300">Thời Gian (ms)</TableHead>
                      <TableHead className="font-semibold text-slate-300">Hành Động</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((result, index) => (
                      <TableRow key={index} className="hover:bg-slate-800/30 border-slate-800">
                        <TableCell className="font-mono text-sm text-slate-300">{result.domain}</TableCell>
                        <TableCell>
                          {result.status === "checking" ? (
                            <Badge className="bg-blue-950/50 text-blue-400 hover:bg-blue-950/50 border border-blue-800">
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                              Đang kiểm tra
                            </Badge>
                          ) : result.status === "pending" ? (
                            <Badge className="bg-slate-800/50 text-slate-400 hover:bg-slate-800/50 border border-slate-700">
                              Chờ xử lý
                            </Badge>
                          ) : result.status === "complete" ? (
                            <Badge className="bg-green-950/50 text-green-400 hover:bg-green-950/50 border border-green-800">
                              Hoàn thành
                            </Badge>
                          ) : result.status === "not-found" ? (
                            <Badge className="bg-yellow-950/50 text-yellow-400 hover:bg-yellow-950/50 border border-yellow-800">
                              Không tìm thấy
                            </Badge>
                          ) : (
                            <Badge className="bg-red-950/50 text-red-400 hover:bg-red-950/50 border border-red-800">
                              Lỗi
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-slate-400">
                          {result.years > 0 ? `${result.years} năm` : "-"}
                        </TableCell>
                        <TableCell className="text-slate-400">{result.firstYear}</TableCell>
                        <TableCell className="text-slate-400">{result.lastYear}</TableCell>
                        <TableCell className="text-slate-400">{result.totalSnapshots}</TableCell>
                        <TableCell className="text-slate-500">
                          {result.timeMs > 0 ? `${result.timeMs}ms` : "-"}
                        </TableCell>
                        <TableCell>
                          <span className="text-slate-600">0</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
