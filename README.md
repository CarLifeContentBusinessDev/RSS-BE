# 팟캐스트 RSS 피드 생성기

> 팟빵, Spotify, YouTube 콘텐츠를 iTunes 호환 RSS 피드로 변환하여 원하는 팟캐스트 앱에서 구독 가능하게 만드는 서비스

[![NestJS](https://img.shields.io/badge/NestJS-E0234E?style=flat&logo=nestjs&logoColor=white)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=flat&logo=supabase&logoColor=white)](https://supabase.com/)

---

## 목차

- [프로젝트 소개](#-프로젝트-소개)
- [주요 기능](#-주요-기능)
- [빠른 시작](#-빠른-시작)
- [환경 설정](#-환경-설정)
- [API 사용법](#-api-사용법)
- [프로젝트 구조](#-프로젝트-구조)

---

## 프로젝트 소개

### 문제 상황
- 팟빵, Spotify, YouTube 콘텐츠를 사용자가 원하는 플레이어에서 재생할 수 있도록 처리할 수 없음

### 해결 방법
각 플랫폼의 콘텐츠를 **표준 RSS 피드**로 변환하여, 사용자가 원하는 플레이어에서 자유롭게 재생할 수 있게 합니다.

### 지원 플랫폼
| 플랫폼 | 상태 | 설명 |
|--------|------|------|
| **팟빵** | 완벽 지원 | 공식 API 사용, 오디오 완벽 제공 |
| **Spotify** | 대부분 지원 | 공식 API 사용, 단독 계약 채널 제외 오디오 제공 |
| **YouTube** | 실험적 | 오디오 추출 가능하나 약관/성능/유지보수비용 이슈 있음 |

---

## 주요 기능

- **팟빵 RSS 생성**: 채널 ID로 즉시 RSS 피드 생성
- **Spotify 연동**: Spotify 팟캐스트를 Apple Podcasts RSS로 변환
- **YouTube RSS 생성**: YouTube 콘텐츠에서 오디오만 추출 및 저장, 저장된 url을 이용해 RSS 피드 생성
- **자동 업데이트**: 매시간 자동으로 새 에피소드 수집 (팟빵, Spotify)
- **iTunes 호환**: 모든 팟캐스트 앱에서 구독 가능한 표준 RSS 형식
- **채널 관리**: 등록한 채널 조회, 삭제, 업데이트

---

## 빠른 시작

### 1. 사전 요구사항

- **Node.js** 18.x 이상
- **npm**
- **Supabase** 계정
- **Cloudflare R2** 계정 
- **Spotify API** 키

### 2. 설치

```bash
# 저장소 클론
git clone <repository-url>
cd <folder-name>

# 의존성 설치
npm install
```

### 3. 환경 변수 설정

루트 디렉토리에 `.env` 파일 생성:

```env
# 필수: Supabase 설정
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_BUCKET_NAME=your-supabase-bucket-name

# Spotify API
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret

# Cloudflare R2
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your_r2_access_key
R2_ACCOUNT_ID=tour_r2_account_id
R2_BUCKET_NAME=your_bucket_name
R2_PUBLIC_URL=https://your-r2-domain.com
DOWNLOAD_FOLDER=youtube

# Optional: YouTube 실행 바이너리 경로 (직접 설치한 경우)
YT_DLP_PATH=/usr/local/bin/yt-dlp

# Optional: yt-dlp 자동 다운로드 캐시 경로
YT_DLP_CACHE_DIR=/app/.cache/yt-dlp

# Base Url
FRONTEND_URL=your-published-domain
```

### 4. 데이터베이스 설정

Supabase에서 아래 SQL을 실행하여 테이블 생성:

```sql
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  thumbnail TEXT,
  type TEXT NOT NULL,
  videos JSONB,
  description TEXT,
  summary TEXT,
  author TEXT,
  copyright TEXT,
  owner JSONB,
  language TEXT DEFAULT 'ko',
  category TEXT,
  content_type TEXT,
  publisher TEXT,
  host TEXT,
  tags JSONB,
  external_rss_url TEXT,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_update TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 5. 서버 실행

```bash
# 개발 모드 (Hot Reload)
npm run start:dev

# 프로덕션 모드
npm run build
npm run start:prod
# 배포환경에 따라 다를 수 있음
```

서버가 `http://localhost:3000`에서 실행됩니다.

### 6. 테스트

```bash
# 헬스 체크
curl http://localhost:3000/api/health

# 응답: {"status":"ok"}
```

---

## 환경 설정

### Supabase 설정 방법

1. [Supabase](https://supabase.com) 가입 및 프로젝트 생성
2. `Settings` → `API` 메뉴에서 다음 정보 복사:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` 키 → `SUPABASE_KEY`
3. SQL Editor에서 위의 테이블 생성 SQL 실행

### Spotify API 설정 방법 (선택)

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) 접속
2. 앱 생성 후 `Client ID`와 `Client Secret` 복사
3. `.env` 파일에 추가

### Cloudflare R2 설정 방법 (선택, YouTube 사용 시)

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) → R2 메뉴
2. 버킷 생성
3. API 토큰 생성 후 `.env` 파일에 추가
4. 공개 도메인 설정 (R2 Public URL)

---

## 📚 API 사용법

> Base URL: `http://localhost:3000` (개발 환경)
> 배포 시 배포 환경 도메인 적용 필수

### 팟빵

#### 1. 팟빵 채널 ID 찾기

팟빵 웹사이트에서 원하는 채널 URL을 확인:
```
예: https://www.podbbang.com/channels/1789807
                                         ↑
                                    채널 ID
```

#### 2. RSS 피드 생성

```bash
curl -X POST http://localhost:3000/api/podbbang/channel \
  -H "Content-Type: application/json" \
  -d '{"channelId": "1789807"}'
```

**응답:**
```json
{
  "rssUrl": "http://localhost:3000/rss/podbbang_1789807"
}
```

#### 3. 채널 업데이트

매시간 자동으로 업데이트되지만, 수동으로도 가능:

```bash
curl -X POST http://localhost:3000/api/podbbang/update/1789807
```

---

### Spotify

#### 1. Spotify 쇼 URL 확인

```
예: https://open.spotify.com/show/3IM0lmZxpFAY7CwMuv9H4g
                                   ↑
                              쇼 ID
```

#### 2. RSS 찾기 (Apple Podcasts 연동)

```bash
curl -X POST http://localhost:3000/api/spotify/find-rss \
  -H "Content-Type: application/json" \
  -d '{"spotifyUrl": "https://open.spotify.com/show/3IM0lmZxpFAY7CwMuv9H4g"}'
```

**성공 시:**
```json
{
  "feedUrl": "https://feeds.acast.com/...",
  "channelId": "spotify_3IM0lmZxpFAY7CwMuv9H4g"
}
```

**실패 시:**
```json
{
  "error": "Podcast not found on Apple Podcasts"
}
```

---

### YouTube

YouTube 기능은 다음 이유로 프로덕션 사용을 권장하지 않습니다:
- YouTube 서비스 약관 위반 가능성
- 저작권 문제
- 높은 처리 시간 (플레이리스트 100개 = 1-3시간)
- 높은 저장 공간 비용

실행 관련 참고:
- 현재 서버는 `YT_DLP_PATH`가 없으면 `yt-dlp-wrap`을 통해 바이너리를 자동 준비합니다.
- 배포 환경에서 GitHub 접근이 제한되면 자동 다운로드가 실패할 수 있으므로 `YT_DLP_PATH`로 고정 경로를 지정하는 것을 권장합니다.

#### YouTube URL 처리

```bash
curl -X POST http://localhost:3000/youtube/process \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=VIDEO_ID"}'
```

**주의**:
- 비디오당 30초~2분 소요
- 100개 비디오 = 약 1-3시간
- R2 저장 공간 필요

---

### 채널 관리

#### 모든 채널 조회

```bash
curl http://localhost:3000/api/channels
```

#### 채널 삭제

```bash
curl -X DELETE http://localhost:3000/api/channel/podbbang_1789807
```

---

## 프로젝트 구조

```
backend/
├── src/
│   ├── modules/
│   │   ├── podbbang/          # 팟빵 관련 로직
│   │   ├── spotify/           # Spotify 관련 로직
│   │   ├── youtube/           # YouTube 관련 로직
│   │   ├── apple-podcasts/    # Apple Podcasts 검색
│   │   ├── rss/               # RSS 피드 생성
│   │   └── channel/           # 채널 관리 API
│   ├── shared/
│   │   └── services/
│   │       ├── channel-db.service.ts  # DB 작업
│   │       └── supabase.service.ts    # Supabase 연결
│   ├── types/                 # TypeScript 타입 정의
│   ├── tasks/                 # 크론 작업 (자동 업데이트)
│   └── main.ts                # 앱 진입점
├── .env                       # 환경 변수
└── package.json
```

---

## 🔧 기술 스택

- **Backend**: NestJS (Node.js + TypeScript)
- **Database**: Supabase (PostgreSQL)
- **Storage**: Cloudflare R2 (S3 호환)
- **YouTube**: yt-dlp, ytpl
- **Scheduler**: @nestjs/schedule (Cron)

---
