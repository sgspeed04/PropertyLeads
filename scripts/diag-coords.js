/**
 * 진단용 임시 스크립트 — VWorld API 502 원인 추가 진단.
 * 1차 진단(HTTP 502 Bad Gateway, UND_ERR_SOCKET)까지 확인됨.
 * 이번엔 (a) Referer 헤더 유무, (b) 지오코더 외 다른 VWorld 엔드포인트(search)도
 * 동일하게 502가 나는지 비교해 "도메인 전체 차단"인지 "지오코더 엔드포인트만
 * 문제"인지 구분한다.
 */

async function fetchWithTimeout(url, headers, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function tryRequest(label, url, headers) {
  console.log(`\n--- ${label} ---`);
  console.log(`URL: ${url.replace(/key=[^&]+/, 'key=***')}`);
  console.log(`Headers: ${JSON.stringify(headers)}`);
  try {
    const res = await fetchWithTimeout(url, headers);
    console.log(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`RAW RESPONSE: ${text.substring(0, 500)}`);
  } catch (e) {
    const cause = e.cause;
    console.log(`✗ 요청 실패: ${e.message}`);
    if (cause) console.log(`  cause: [${cause.code || cause.constructor?.name || ''}] ${cause.message || JSON.stringify(cause)}`);
  }
}

async function main() {
  const key = process.env.VWORLD_KEY;
  if (!key) { console.error('VWORLD_KEY 없음'); process.exit(1); }
  console.log(`VWORLD_KEY 길이: ${key.length}자, 앞 4자리: ${key.substring(0, 4)}...`);

  const addr = encodeURIComponent('서울특별시 성동구 하왕십리동 890');
  const geocoderUrl = `https://api.vworld.kr/req/address?service=address&request=getCoord&version=2.0&crs=epsg:4326&address=${addr}&format=json&type=PARCEL&key=${key}`;
  const searchUrl = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&size=1&query=${encodeURIComponent('성동구')}&type=address&format=json&key=${key}`;
  const dataUrl = `https://api.vworld.kr/req/data?service=data&request=GetFeature&version=2.0&size=1&format=json&key=${key}&data=LT_C_ADSIGG_INFO`;

  const baseHeaders = { 'Accept': 'application/json, text/plain, */*' };
  const uaHeaders = { ...baseHeaders, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
  const refHeaders = { ...uaHeaders, 'Referer': 'https://www.vworld.kr/', 'Origin': 'https://www.vworld.kr' };

  await tryRequest('지오코더 / 헤더없음', geocoderUrl, baseHeaders);
  await tryRequest('지오코더 / UA만', geocoderUrl, uaHeaders);
  await tryRequest('지오코더 / UA+Referer+Origin', geocoderUrl, refHeaders);
  await tryRequest('검색(search) API / UA만', searchUrl, uaHeaders);
  await tryRequest('데이터(data) API / UA만', dataUrl, uaHeaders);

  // 아웃바운드 IP 확인 (러너 IP가 어느 대역인지 확인용)
  console.log('\n--- 러너 아웃바운드 IP 확인 (ifconfig.me) ---');
  try {
    const res = await fetchWithTimeout('https://ifconfig.me/ip', {});
    console.log(`IP: ${await res.text()}`);
  } catch (e) {
    console.log(`✗ IP 확인 실패: ${e.message}`);
  }
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
