/**
 * 진단용 임시 스크립트 — VWorld 지오코더 API 응답 원문 확인.
 * fetch-redevelopment.js의 geocodeAddress()가 753/753건 전부 실패했는데
 * 원인(키 문제/도메인 제한/파라미터 오류 등)을 raw 응답으로 확인.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function main() {
  const key = process.env.VWORLD_KEY;
  if (!key) { console.error('VWORLD_KEY 없음'); process.exit(1); }
  console.log(`VWORLD_KEY 길이: ${key.length}자, 앞 4자리: ${key.substring(0, 4)}...`);

  const addresses = [
    '서울특별시 성동구 하왕십리동 890',
    '서울특별시 강남구 반포동 539',
    '서울특별시 종로구 숭인동 766',
  ];

  for (const addr of addresses) {
    console.log(`\n=== 주소: "${addr}" ===`);
    const url = `https://api.vworld.kr/req/address?service=address&request=getCoord&version=2.0&crs=epsg:4326&address=${encodeURIComponent(addr)}&format=json&type=PARCEL&key=${key}`;
    console.log(`URL: ${url.replace(key, '***')}`);
    try {
      const res = await fetchWithTimeout(url);
      console.log(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      console.log(`RAW RESPONSE: ${text}`);
    } catch (e) {
      const cause = e.cause;
      console.log(`✗ 요청 실패: ${e.message}`);
      if (cause) console.log(`  cause: [${cause.code || cause.constructor?.name || ''}] ${cause.message || JSON.stringify(cause)}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // http(비TLS) 버전도 시도 — VWorld 옛 문서 예제가 http를 쓰는 경우가 있음
  console.log('\n\n########## HTTP(비TLS) 버전 시도 ##########');
  const httpUrl = `http://api.vworld.kr/req/address?service=address&request=getCoord&version=2.0&crs=epsg:4326&address=${encodeURIComponent('서울특별시 성동구 하왕십리동 890')}&format=json&type=PARCEL&key=${key}`;
  try {
    const res = await fetchWithTimeout(httpUrl);
    console.log(`HTTP ${res.status} ${res.statusText}`);
    console.log(`RAW RESPONSE: ${await res.text()}`);
  } catch (e) {
    const cause = e.cause;
    console.log(`✗ 요청 실패: ${e.message}`);
    if (cause) console.log(`  cause: [${cause.code || cause.constructor?.name || ''}] ${cause.message || JSON.stringify(cause)}`);
  }
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
