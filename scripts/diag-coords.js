/**
 * 진단용 임시 스크립트 — upisRebuild(OA-2253) 응답에서 실제 좌표를 얻을 수 있는
 * 필드가 있는지, LOGVM/PSTN_NM에 지오코딩 가능한 주소 텍스트가 들어있는지 확인.
 * 현재 코드(rowToProject)가 찾는 CNTRD_Y/LAT/Y_COORD/LAT_CD 필드가 실제로는
 * 응답에 없어서 전체 761개 구역이 전부 "구 중심좌표+지터"로 표시되고 있음이
 * 확인됨 — 이 스크립트로 원인과 대안(LOGVM 지오코딩)을 검증한다.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

async function fetchWithTimeout(url, timeoutMs = 30000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders }, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function main() {
  const key = process.env.SEOUL_API_KEY;
  if (!key) { console.error('SEOUL_API_KEY 없음'); process.exit(1); }

  async function fetchRange(start, end) {
    const urls = [
      `https://openapi.seoul.go.kr:443/rest/${key}/json/upisRebuild/${start}/${end}/`,
      `http://openapi.seoul.go.kr:8088/${key}/json/upisRebuild/${start}/${end}/`,
    ];
    let res, lastErr;
    for (const url of urls) {
      try {
        res = await fetchWithTimeout(url, 30000, { Referer: 'https://data.seoul.go.kr/' });
        break;
      } catch (e) { lastErr = e; console.warn(`  ✗ ${url}: ${e.message}`); }
    }
    if (!res) throw lastErr;
    const json = await res.json();
    const root = json.upisRebuild || json;
    return { rows: root.row || [], total: root.list_total_count };
  }

  // 서로 다른 구간(오래된/중간/최신 항목) 샘플링 — LOGVM 값 패턴이 시기별로
  // 다를 수 있어 앞부분만 보면 오판할 수 있음
  const ranges = [[1, 5], [3000, 3005], [6570, 6579]];
  for (const [start, end] of ranges) {
    console.log(`\n########## 구간 ${start}-${end} ##########`);
    const { rows, total } = await fetchRange(start, end);
    if (start === 1) console.log(`전체 ${total}건`);
    for (const r of rows) {
      console.log('--- row ---');
      console.log('RGN_NM   :', r.RGN_NM);
      console.log('LOGVM    :', r.LOGVM);
      console.log('PSTN_NM  :', r.PSTN_NM);
      console.log('전체 필드:', JSON.stringify(r));
      console.log();
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
