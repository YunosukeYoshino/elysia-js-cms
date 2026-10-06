# 性能改善の運用境界

## 公開レスポンス圧縮

匿名 GET の JSON / テキストは 1 KiB〜1 MiB の範囲で、クライアントが gzip を許可し、
圧縮後のサイズが小さくなるときのみ圧縮します。`Vary: Accept-Encoding` を設定し、
既存の Vary 値を保持します。圧縮時に古い Content-Length / Accept-Ranges を除去し、
強い ETag を弱い ETag に変更します。

認証ヘッダー・Cookie 付きリクエスト、認証 API、Set-Cookie、private/no-store/no-transform、
エラー、圧縮済みデータ、画像、Response/ストリームは対象外です。認証秘密を含む本文の
圧縮サイドチャネルを避け、ファイルストリームをメモリに読み込まない設計です。

実装は Elysia の公式 mapResponse ライフサイクルに従います。
https://elysiajs.com/essential/life-cycle#map-response

## 拡張の判断

SQLite の現段階ではパーティショニングや読み書きレプリカ分離を導入しません。
読み取りレプリカは整合性・失効要件を明確化してから別DBへの移行時に検討します。
CDN は公開アセット限定で、ユーザーの認可を含む API をそのまま共有キャッシュしません。
