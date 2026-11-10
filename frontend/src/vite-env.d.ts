/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** API BarcodeDetector (Shape Detection) — non encore dans lib.dom. */
interface DetectedBarcode { rawValue: string; format: string }
interface BarcodeDetectorInstance { detect(source: CanvasImageSource | ImageBitmapSource): Promise<DetectedBarcode[]> }
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}
interface Window { BarcodeDetector?: BarcodeDetectorCtor }

/** Événement beforeinstallprompt (PWA). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
