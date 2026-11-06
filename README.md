# 올영프라이스 — Netlify 프런트엔드 + 별도 검색 서버

## 왜 Netlify에서 404가 났나요?
Netlify Drop로 올린 HTML은 정적 파일입니다. 기존 코드의 `/api/oliveyoung/search`는 Node.js/Playwright 서버가 제공하는 주소라서, Netlify에 HTML만 올리면 Netlify가 해당 API 경로를 찾지 못해 404를 반환합니다. 올리브영의 오류가 아니라 프런트엔드와 API 서버가 분리되지 않은 배포 구성 문제입니다.

## 배포 구성
- Netlify: `index.html`, `api-config.js` 등 정적 화면 제공
- Render: `server.js`를 Docker/Playwright로 실행해 `/api/oliveyoung/search` 제공
- Netlify의 `api-config.js`에 Render 서비스 URL을 입력해 두 서버를 연결

## 1) 검색 서버(Render) 배포
1. 이 프로젝트 폴더 전체를 GitHub 저장소에 올립니다. `index.html`, `server.js`, `package.json`, `Dockerfile`, `render.yaml`이 모두 포함되어야 합니다.
2. Render에서 **New + → Blueprint** 또는 **New + → Web Service**로 해당 GitHub 저장소를 연결합니다. Blueprint를 선택하면 `render.yaml` 설정을 읽습니다. Docker 런타임을 사용해야 합니다.
3. 배포가 끝나면 Render 서비스 주소를 복사합니다. 예: `https://oliveprice-api.onrender.com`
4. Render 대시보드의 서비스 URL 뒤에 `/api/health`를 붙여 열었을 때 `{"ok":true,...}` JSON이 나오면 서버가 실행 중인 것입니다. 첫 요청은 무료 인스턴스는 15분간 요청이 없으면 잠들고, 다음 요청 때 재기동에 약 1분 정도 걸릴 수 있습니다. Playwright/Chromium은 메모리를 많이 사용하므로 무료 인스턴스에서 메모리 부족으로 재시작될 수 있습니다. 이 경우 더 큰 유료 인스턴스가 필요할 수 있습니다.

## 2) Netlify 정적 사이트 연결
1. `api-config.js` 파일을 메모장으로 엽니다.
2. 아래 줄의 빈 따옴표 안에 실제 Render 주소를 입력하고 저장합니다.

```js
window.OLIVEPRICE_API_BASE = 'https://여기에-실제-Render-주소';
```

3. `index.html`, `api-config.js`, 나머지 기존 정적 파일을 포함해 프로젝트 폴더를 Netlify에 다시 배포합니다. `api-config.js`를 빠뜨리면 연결되지 않습니다.
4. Netlify 사이트를 새로고침한 뒤 `토리든`을 검색합니다.

## 3) 확인 순서
- Render `/api/health`가 JSON으로 응답하는지 확인
- Netlify 사이트에서 개발자도구(F12) → Network → `oliveyoung/search` 요청을 확인
- 요청 URL이 `https://실제-Render주소/api/oliveyoung/search?...`인지 확인
- 404가 계속되면 `api-config.js`에 Render URL이 정확히 들어갔는지, 재배포했는지 확인
- 502면 검색 서버는 연결됐지만 올리브영 접근/페이지 파싱 단계에서 실패한 것. 화면의 오류 내용을 확인

## 주의
- Render 서비스 주소는 실제 배포 후 발급되므로 이 프로젝트 파일에 미리 넣을 수 없습니다. 반드시 사용자 Render URL을 `api-config.js`에 입력해야 합니다.
- `server.js`는 올리브영 공개 온라인몰 검색 페이지를 Playwright로 읽습니다. 공식 제휴 API가 아니며 사이트 구조 변경, 자동화 접근 제한, 일시 장애로 검색이 실패할 수 있습니다. 차단을 우회하지 않습니다.
- 검색 결과가 앱과 완전히 동일하거나 모든 상품이 항상 노출된다고 보장할 수 없습니다.
- Render 유료/무료 플랜의 가용성과 비용은 배포 시점의 Render 정책을 확인하세요. 무료 인스턴스는 절전/재기동으로 첫 검색이 느릴 수 있습니다.
- `api-config.js`에 비밀키를 넣지 마세요. 이 파일은 브라우저에 공개됩니다.

## 로컬 실행(Windows)
Node.js 20 이상 설치 후 `start.bat` 실행. 또는 프로젝트 폴더에서 `npm install`, `npx playwright install chromium`, `npm start` 실행 후 `http://localhost:3000` 접속.
