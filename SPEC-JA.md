# ホワイトボード記録アプリ仕様書

## 1. システム概要

| 項目 | 内容 |
|------|------|
| **目的** | ホワイトボードの内容を無音・自動記録し、リアルタイム表示・履歴閲覧・一括ダウンロードを可能にする |
| **構成** | iOSネイティブアプリ（SwiftUI）+ Node.js APIサーバー |
| **対象環境** | iPhone（iOS 16+）、サーバーは Ubuntu 24.04（クラウド） |
| **開発環境** | macOS + Docker（PostgreSQL/Redis） |

---

## 2. バックエンド仕様

### 2.1 技術スタック

| レイヤー | 技術 |
|---------|------|
| ランタイム | Node.js (LTS) |
| フレームワーク | Express |
| ORM | Prisma |
| DB | PostgreSQL 15+ |
| キャッシュ/一時保存 | Redis |
| ファイルストレージ | ローカルファイルシステム（`/var/whiteboard-images/`） |
| 画像変換 | sharp（HEIC → JPEG 変換用） |
| ファイルアップロード | multer（multipart/form-data 受信） |
| ZIP生成 | yazl |
| リアルタイム通知 | SSE（Server-Sent Events） |

> **開発環境注記**: `IMAGE_DIR` 環境変数で保存先を変更可能。開発時は `/tmp/whiteboard-images/` を使用（`/var` への書き込み権限回避のため）。

### 2.2 データベーススキーマ（Prisma）

```prisma
model Room {
  id        String   @id @default(cuid())
  code      String   @unique // 6文字以上の任意文字列
  createdAt DateTime @default(now())
  images    Image[]
}

model Image {
  id        String   @id @default(cuid())
  roomId    String
  room      Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  filename  String   // UUID.heic
  path      String   // /var/whiteboard-images/{roomId}/{filename}
  createdAt DateTime @default(now())

  @@index([roomId, createdAt])
}
```

### 2.3 Redis 用途

| 用途 | キー例 | 値 | TTL |
|------|--------|-----|-----|
| **ライブ最新画像** | `live:{roomCode}` | HEICバイナリ（Buffer） | 10秒 |
| **SSE接続管理** | ※インメモリ（Map）で管理 | Responseオブジェクト群 | 接続存続期間 |

> Redisはライブ用最新画像の一時キャッシュにのみ使用。永続保存はFS+PostgreSQL。

### 2.4 API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| POST | `/api/rooms` | ルーム作成（code生成または指定）。指定codeが既存と重複する場合は **409 Conflict** を返す |
| GET | `/api/rooms/:code` | ルーム情報取得 |
| POST | `/api/rooms/:code/images` | **保存用**画像アップロード（`multipart/form-data`、フィールド名 `image`） |
| POST | `/api/rooms/:code/live` | **ライブ用**画像アップロード（`multipart/form-data`、フィールド名 `image`） |
| GET | `/api/rooms/:code/live` | **ライブ用**最新画像取得（Redisから直近2秒のHEIC） |
| GET | `/api/rooms/:code/images` | 保存画像一覧取得（時系列降順、`?page` `&limit`、デフォルト limit=20、最大100） |
| GET | `/api/rooms/:code/images/:id` | 単一画像取得（`?format=jpeg` でHEIC→JPEG変換） |
| GET | `/api/rooms/:code/download` | 全画像ZIP一括ダウンロード（JPEG変換済み） |
| GET | `/api/rooms/:code/events` | SSEエンドポイント（新画像通知） |
| DELETE | `/api/rooms/:code/images/:id` | 画像削除（自動削除以外では基本不使用） |

> **注記**: Express に `trust proxy` を設定。リバースプロキシ（nginx等）経由時にクライアントIPを正しく取得するため。

### 2.5 画像保存フロー

#### 保存用（0.1fps / 10秒間隔）
```
1. iOSアプリから HEIC（1080p/4K）を multipart/form-data（フィールド名: image）で POST /api/rooms/:code/images
2. APIサーバーが /var/whiteboard-images/{roomId}/ にファイル保存
3. PostgreSQLにメタデータ（path, createdAt）を記録
4. SSEで接続中の表示端末に "new_image" イベントをブロードキャスト
5. 365日経過後、cronジョブでファイル＋DBレコードを自動削除
```

#### ライブ用（0.5fps / 2秒間隔）
```
1. iOSアプリから HEIC（1080p、品質0.8）を multipart/form-data（フィールド名: image）で POST /api/rooms/:code/live
2. APIサーバーが Redis key: live:{roomCode} に上書き保存（TTL=10s）
3. SSEで接続中の表示端末に "live_update" イベントをブロードキャスト
4. 表示端末はイベント受信後、GET /api/rooms/:code/live でHEICを取得
```

### 2.6 HEIC → JPEG 変換

| シーン | 動作 |
|--------|------|
| **一括ダウンロード** | sharpで全HEICをJPEGに変換 → ZIP圧縮して配信 |
| **単一画像表示（非iOS）** | `?format=jpeg` クエリで変換後に配信 |
| **通常取得** | HEICのまま配信（iPhone表示前提） |

### 2.7 自動削除（365日保持）

| 項目 | 仕様 |
|------|------|
| **保持期間** | 作成日時から365日 |
| **削除方式** | サーバー側 cron ジョブ（毎日午前3時実行） |
| **削除対象** | PostgreSQLレコード + ファイルシステムの両方 |
| **ライブ用Redisデータ** | TTLで自動削除（10秒） |

---

## 3. フロントエンド（iOS）仕様

### 3.1 技術スタック

| 項目 | 内容 |
|------|------|
| フレームワーク | SwiftUI |
| カメラ | AVFoundation（AVCaptureSession） |
| 画像フォーマット | HEIC（アルファチャンネル除去済み） |
| 通信 | URLSession（アップロード / SSE購読） |
| UIスタイル | Liquid Glass（`.tabViewStyle(.sidebarAdaptable)`） |

### 3.2 画面構成

```
┌─────────────────────────────────────┐
│  ルーム: ABC123          [×]        │  ← ルーム情報バー（上部固定）
├─────────────────────────────────────┤
│                                     │
│         [ 録画 | 表示 ]              │  ← TabView（Liquid Glass）
│                                     │
├─────────────────────────────────────┤
│                                     │
│           メインエリア              │
│                                     │
└─────────────────────────────────────┘
```

#### 画面遷移フロー

```
[HomeView] ──→ [CreateRoomView] ──┐
    │                              │
    └──→ [JoinRoomView] ──────────┘
                  │
                  ↓
           [MainView] ──→ TabView(録画/表示)
                  │
                  └── ルーム履歴（UserDefaults保存）
```

- **HomeView**: 新規ルーム作成 / ルーム参加 / 参加履歴一覧
- **CreateRoomView**: 新規ルーム作成（ランダムコード or 任意コード）
- **JoinRoomView**: ルームコード入力して参加
- **MainView**: ルーム参加後のメイン画面。上部にルーム情報バー、下部にTabView

### 3.3 ルーム情報バー

| 項目 | 仕様 |
|------|------|
| **表示位置** | 画面上部、Safe Area内 |
| **背景** | `.ultraThinMaterial`（Liquid Glass風） |
| **左側** | ルームラベル + ルームコード（等幅フォント） |
| **右側** | 退出ボタン（×）。タップでホーム画面に戻る |

### 3.4 録画モード

| 項目 | 仕様 |
|------|------|
| **カメラ方式** | `AVCaptureVideoDataOutput`（ビデオストリームからフレーム切り出し） |
| **シャッター音** | 無音（`AVCapturePhotoOutput` を使用しないため音が鳴らない） |
| **プレビュー** | なし（画面は黒または最小UIのみ） |
| **画面輝度** | 最低輝度に固定 |
| **画面ロック** | 無効化（`UIApplication.shared.isIdleTimerDisabled = true`） |
| **解像度** | 1080p（ライブ用）/ 1080p〜4K（保存用、設定で選択） |
| **4K実装** | `.high` プリセットではなく、`AVCaptureDevice.Format` を直接選択。3840×2160以上のフォーマットを優先 |
| **ストリーム制御** | `activeVideoMinFrameDuration` / `activeVideoMaxFrameDuration` でカメラ出力を1fpsに制限 |
| **AF/AE/AWB** | AE・AWBはロック。AFは連続自動焦点（`.continuousAutoFocus`） |
| **HDR** | デフォルト（明示的ON/OFF制御なし） |
| **フォーマット** | HEIC（アップロード前にアルファチャンネルを除去） |
| **カメラ選択** | 背面カメラの複数レンズ切り替え対応（0.5x / 1x / 2x / 3x / 5x 等、デバイス依存） |
| **セッション復帰** | `AVCaptureSessionRuntimeError` 時・`didBecomeActive` 時に自動再起動 |

#### アップロードスケジュール（デュアルストリーム）

| 種別 | 間隔 | 解像度 | HEIC品質 | 送信先 | 目的 |
|------|------|--------|----------|--------|------|
| **ライブ用** | 2秒（0.5fps） | 1080p | 0.8 | `POST /api/rooms/:code/live` | リアルタイム監視用（Redis一時保存） |
| **保存用** | 10秒（0.1fps） | 1080p/4K | 0.95 | `POST /api/rooms/:code/images` | 履歴・ダウンロード用（永続保存） |

> 録画開始後、両方のタイマーを並行して動作させる。ライブ用は軽量HEIC、保存用は高品質HEIC。
> アップロード前に `removingAlpha(from:)` でアルファチャンネルを除去し、ファイルサイズとメモリ使用量を最適化。

#### ルーム参加フロー

1. 「新規ルーム作成」→ サーバーにPOST → 発行されたコードを入力欄に反映
2. 「参加する」→ 入力したコードでルーム参加 → 録画開始
3. 録画は **1ルーム1端末** でのみ実行（排他制御は運用で管理、サーバー側では特に制限なし）
4. 参加したルームコードは `RoomHistoryStore`（UserDefaults）に保存し、HomeViewで履歴一覧表示

### 3.5 表示モード

| 項目 | 仕様 |
|------|------|
| **参加方法** | ルームコードを入力して参加（HomeView経由） |
| **初期表示** | 最新画像をフルスクリーン表示 |
| **サムネイル一覧** | 画面下部に時系列で横スクロール（Photosアプリ風） |
| **画像切り替え（フルスクリーン）** | 左右スワイプ。**スワイプ量に応じて複数枚進む**（リアルタイム、80pxごとに1枚） |
| **画像切り替え（サムネイル）** | タップで選択 |
| **ズーム** | ピンチで最大5倍。ダブルタップでズームイン/アウトトグル |
| **自動ページ展開** | 最後の画像まで進んだ状態でさらにスワイプすると、自動で「もっと見る」を読み込み、次の画像へ進む |
| **同時接続** | 複数端末から同じルームコードで接続可能 |

#### 自動更新制御

| 状態 | SSE購読 | 動作 |
|------|---------|------|
| **最新画像を表示中** | ✅ 購読中 | `live_update` イベント受信時に `GET /api/rooms/:code/live` を取得して画面更新 |
| **過去画像を閲覧中** | ❌ 停止 | 自動更新せず、手動更新ボタンを表示。一覧は `GET /api/rooms/:code/images` で取得 |

### 3.6 サーバーURL設定

| 項目 | 内容 |
|------|------|
| **設定場所** | iOS 設定アプリ → BoardLog |
| **設定キー** | `api_base_url`（UserDefaults） |
| **デフォルト（Debug）** | `http://localhost:3000` |
| **デフォルト（Release）** | `https://board.rnrr.one` |
| **設定方法** | `BoardLog/Settings.bundle/Root.plist` で定義 |

---

## 4. リアルタイム通知（SSE）仕様

### 4.1 SSE エンドポイント

```
GET /api/rooms/:code/events
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

### 4.2 イベント種別

| イベント名 | 送信タイミング | ペイロード例 |
|-----------|--------------|-------------|
| `connected` | SSE接続確立時 | `{"type":"connected"}` |
| `new_image` | 保存用画像がアップロードされた時 | `{"type":"new_image","id":"xxx","timestamp":"2026-05-08T11:30:00Z"}` |
| `live_update` | ライブ用画像がアップロードされた時 | `{"type":"live_update","timestamp":"2026-05-08T11:30:00Z"}` |
| `ping` | 接続維持用（30秒間隔） | `{"type":"ping"}` |

### 4.3 フロー

```
[録画iPhone] ──HEICアップロード──→ [APIサーバー]
                                        │
                                        ├─ 保存用 → FS + DB + SSEブロードキャスト
                                        └─ ライブ用 → Redis + SSEブロードキャスト
                                              │
                                              ↓
[表示iPhone A] ←──── SSE ──────┘
[表示iPhone B] ←──── SSE ──────┘
```

> SSEには画像バイナリは流さない。更新通知（JSON）のみを流し、実際の画像は別途HTTP GETで取得する。

---

## 5. 画像容量見積もり

### 5.1 前提条件

- 1日の撮影時間：360分（6時間）
- HEIC圧縮率：1080pで約0.8MB/枚、4Kで約1.5MB/枚

### 5.2 容量計算

| 画質 | ライブ用（0.5fps） | 保存用（0.1fps） | 1日合計 | 365日合計 |
|------|-------------------|-----------------|---------|----------|
| **1080p固定** | 2秒×0.4MB = ~4.3GB/日（※Redis一時保持なし） | 10秒×0.8MB = ~1.7GB/日 | ~1.7GB/日 | **~620GB/年** |
| **4K保存** | 同上 | 10秒×1.5MB = ~3.2GB/日 | ~3.2GB/日 | **~1.2TB/年** |

> ※ライブ用はRedisに最新1枚のみ保持し上書きするため、サーバーストレージ消費は無視できる。

---

## 6. 開発・デプロイ環境

| 環境 | 構成 |
|------|------|
| **開発（API）** | macOS + Docker Compose（PostgreSQL + Redis） |
| **本番（API）** | Ubuntu 24.04 + PostgreSQL + Redis + PM2（Node.jsプロセス管理） |
| **ストレージ** | `/var/whiteboard-images/`（SSD推奨）。開発時は `/tmp/whiteboard-images/` |
| **バックアップ** | ファイルシステム + DBの定期バックアップ（別途検討） |
| **iOSアプリ配布** | App Store（TestFlightも併用） |

---

## 7. 懸念事項と対策

| 懸念 | 対策 |
|------|------|
| **バッテリー消費** | 1080p推奨、AE/AWBロック、最低輝度、プレビューなしで緩和 |
| **発熱** | 同上。長時間運用時は充電しながら使用を推奨 |
| **ストレージ容量** | 1ルーム/年で620GB〜1.2TB。クラウドストレージコスト要確認 |
| **HEIC互換性** | API側でJPEG変換対応済み（一括DL・単一取得時） |
| **App Store審査** | ビデオストリーム方式（PhotoOutput不使用）なので無音撮影の技術的問題なし。用途を明確に説明 |
| **画面ロック無効化** | `isIdleTimerDisabled` を使用。審査時に用途が正当であることを説明 |
| **バックグラウンド動作** | iOSの制限により、ホーム画面に戻るとカメラセッション停止。フォアグラウンド運用が前提。`didBecomeActive` で自動再起動 |
| **4K対応機種** | 4Kフォーマット非対応デバイスは自動的に1080pにフォールバック |

---

## 8. 今後の拡張候補（非必須）

- 画像OCRでテキスト抽出・検索可能にする
- 差分検出でホワイトボードに変更があったフレームのみ保存
- 保存画像からタイムラプス動画を自動生成
- ルームにパスワードを設定するオプション
- 録画端末の排他制御をサーバー側で実装

---

## 9. 用語・補足

| 用語 | 説明 |
|------|------|
| **HEIC** | iPhoneの標準画像フォーマット。JPEG同等画質で約半分のファイルサイズ |
| **SSE** | Server-Sent Events。HTTP経由でサーバーからクライアントに单向にイベントをプッシュする技術 |
| **0.1fps** | 10秒に1フレーム。保存用の撮影間隔 |
| **0.5fps** | 2秒に1フレーム。ライブ表示用の撮影・通知間隔 |
| **AVCaptureVideoDataOutput** | カメラのリアルタイムビデオフレームを取得するAVFoundationクラス。PhotoOutputを使わないためシャッター音が鳴らない |
| **Liquid Glass** | iOS 26 で導入された新しいUIスタイル。`.tabViewStyle(.sidebarAdaptable)` 等で適用 |
| **RoomHistoryStore** | UserDefaults を使用した参加ルームコードのローカル保存機構 |
| **Alpha除去** | HEIC/JPEG変換前に画像のアルファチャンネル（透過情報）を除去すること。ファイルサイズ削減とメモリ最適化に効果がある |
