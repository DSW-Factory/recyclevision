# RecycleVision Cloud

Migración standalone de la aplicación local `localhost:8000`.

- Mantiene `web/index.html`, `web/styles.css` y `web/app.js` como base visual/UX.
- No contiene ningún módulo de EXPOCON.
- Inferencia browser-first con el modelo entrenado RecycleVision v1 (29 clases) exportado a ONNX.
- Intelligence, Histórico, Carbon Studio, Learning y asesor local conservan su interfaz.
- Histórico/correcciones se guardan en el navegador en esta primera etapa cloud.
- Entrenamiento GPU y secretos de IA externa quedan deliberadamente fuera del navegador.

## Modelo

`RecycleVision v1 YOLO26s · 29 clases`

La primera carga descarga el ONNX y luego la inferencia se ejecuta en el dispositivo vía WebGPU/WASM.