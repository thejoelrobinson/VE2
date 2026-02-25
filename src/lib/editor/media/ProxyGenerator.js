// Generate 720p proxies for large files via FFmpeg.wasm
import { ffmpegBridge } from '../export/FFmpegBridge.js';
import logger from '../../utils/logger.js';

const PROXY_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100MB
const PROXY_HEIGHT = 720;

export const proxyGenerator = {
  _proxies: new Map(), // mediaId -> { url, file }

  needsProxy(mediaItem) {
    return mediaItem.size > PROXY_THRESHOLD_BYTES &&
           (mediaItem.type === 'video');
  },

  hasProxy(mediaId) {
    return this._proxies.has(mediaId);
  },

  getProxyUrl(mediaId) {
    const proxy = this._proxies.get(mediaId);
    return proxy ? proxy.url : null;
  },

  async generateProxy(mediaItem, onProgress) {
    if (!this.needsProxy(mediaItem)) return null;
    if (this._proxies.has(mediaItem.id)) return this._proxies.get(mediaItem.id).url;

    logger.info(`Generating proxy for ${mediaItem.name} (${(mediaItem.size / 1024 / 1024).toFixed(0)}MB)`);

    try {
      // Load FFmpeg if needed
      await ffmpegBridge.load();

      // Read source file
      const response = await fetch(mediaItem.url);
      const sourceData = new Uint8Array(await response.arrayBuffer());

      const inputExt = mediaItem.name.split('.').pop() || 'mp4';
      const inputFile = `proxy_input.${inputExt}`;
      const outputFile = 'proxy_output.mp4';

      await ffmpegBridge.writeFile(inputFile, sourceData);

      // Calculate proxy dimensions maintaining aspect ratio
      const scale = mediaItem.height > PROXY_HEIGHT
        ? PROXY_HEIGHT / mediaItem.height
        : 1;
      const proxyWidth = Math.round(mediaItem.width * scale / 2) * 2; // Ensure even
      const proxyHeight = Math.round(mediaItem.height * scale / 2) * 2;

      // Transcode to 720p proxy
      await ffmpegBridge.exec([
        '-i', inputFile,
        '-vf', `scale=${proxyWidth}:${proxyHeight}`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-y', outputFile
      ]);

      const outputData = await ffmpegBridge.readFile(outputFile);
      const blob = new Blob([outputData.buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);

      // Cleanup FFmpeg files
      await ffmpegBridge.deleteFile(inputFile);
      await ffmpegBridge.deleteFile(outputFile);

      this._proxies.set(mediaItem.id, { url, blob });
      logger.info(`Proxy generated for ${mediaItem.name}: ${(blob.size / 1024 / 1024).toFixed(1)}MB`);

      if (onProgress) onProgress(1);
      return url;
    } catch (err) {
      logger.error(`Proxy generation failed for ${mediaItem.name}:`, err);
      return null;
    }
  },

  revokeProxy(mediaId) {
    const proxy = this._proxies.get(mediaId);
    if (proxy) {
      URL.revokeObjectURL(proxy.url);
      this._proxies.delete(mediaId);
    }
  },

  cleanup() {
    for (const [id] of this._proxies) {
      this.revokeProxy(id);
    }
    this._proxies.clear();
  }
};

export default proxyGenerator;
