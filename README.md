# KT ALT Reader (Web)

KT-ALT 高度ロガーの記録データ（気圧・BMP温度）を USB シリアル経由で読み出し、外気温を入力して高度に換算するブラウザ版ツールです。

## 使い方

1. **Chrome または Edge** でページを開く（Web Serial API を使うため。Firefox / Safari は CSV の表示のみ）
2. ロガーを USB で接続し、「Select Port」でポートを選択
3. 「Read Device」でデータを読み出す
4. 外気温（°C）を入力して「Convert」を押すと、下のグラフに高度を表示

基準気圧（Ref P）は読み出し時に先頭 1 秒間の平均が自動で入ります。

## Android で使う

Android の Chrome では、USB シリアルデバイスを Web Serial API で列挙できない端末が多いため、
WebUSB 経由で USB CDC-ACM を扱う [web-serial-polyfill](https://github.com/google/web-serial-polyfill)（Google, Apache-2.0。`vendor/` に同梱）を使って通信します。

- ページは HTTPS（GitHub Pages など）で開いてください。Android ではファイルを直接開く方法では動作しません。
- 「Select Port」を押すと USB デバイスの選択画面が出ます。選択後、Android の「Chrome に USB デバイスへのアクセスを許可しますか」に許可してください。
- Android では USB ディスクリプタからシリアル番号を直接読むため、ファームウェアの `I` コマンドがなくても S/N が表示されます。

## 高度換算式

```
h = (T0 / 0.0065) * (1 - (P / P_ref) ^ 0.1903)
```

T0: 入力した外気温 [K]、P_ref: 基準気圧 [hPa]

## デバイス S/N

ファームウェアが `I` コマンドに `SN:<チップID>` で応答する場合（flash_BMP580_4 以降）に表示されます。

## CSV

デスクトップ版（KT_ALT_Reader）と同じ形式で保存・読み込みできます。

## オフラインで使う

`index.html` と `app.js` を同じフォルダに置き、`index.html` をダブルクリックで開けばインターネット接続なしで動作します。
