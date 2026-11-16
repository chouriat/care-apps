// Added in the PR #34 review. Gemini's screen only worked when a test passed in a fake
// `photoPicker`: the app route passed none, so on a phone "Take photo" and "Choose from library"
// did nothing. This is the real camera and library adapter, built on expo-image-picker (camera and
// library) and expo-image-manipulator (resize and JPEG), both part of the Expo SDK and in Expo Go.
// Bytes are read with expo-file-system's `File`, which works in Hermes (no `Buffer`, no `atob`).
import { File, Paths } from 'expo-file-system';
import { SaveFormat, ImageManipulator } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { MAX_PRESCRIPTION_PHOTO_BYTES } from './rx-storage';

export interface PickedPhotoFile {
  uri: string;
  width: number;
  height: number;
}

export interface CapturedPrescriptionPhoto {
  bytes: Uint8Array;
  width: number;
  height: number;
  contentType: string;
}

export interface CaptureOptions {
  maxDimensionPx: number;
  jpegQuality: number;
}

/** Thrown when the person refuses camera or photo library access. */
export class PrescriptionPhotoPermissionError extends Error {
  constructor() {
    super('PHOTO_PERMISSION_DENIED');
    this.name = 'PrescriptionPhotoPermissionError';
  }
}

export interface ExpoPhotoPickerModules {
  /** Opens the camera or the library. `null` when the person cancels. */
  launch: (mode: 'take' | 'pick') => Promise<PickedPhotoFile | null>;
  /** Re-encodes the image as JPEG, resized so neither side is larger than `size` asks. */
  toJpeg: (
    uri: string,
    size: { width?: number; height?: number } | null,
    quality: number,
  ) => Promise<PickedPhotoFile>;
  readBytes: (uri: string) => Promise<Uint8Array>;
  /** Removes the app's own copy of the photo (only inside the app's cache folder). Never throws. */
  deleteLocal: (uri: string) => void;
}

/** Lower JPEG qualities tried, in order, only when quality 0.8 is still over 2 MB. */
export const FALLBACK_JPEG_QUALITIES = [0.6, 0.4, 0.25] as const;

export function targetResize(
  width: number,
  height: number,
  maxDimensionPx: number,
): { width: number } | { height: number } | null {
  if (width <= maxDimensionPx && height <= maxDimensionPx) return null;
  return width >= height ? { width: maxDimensionPx } : { height: maxDimensionPx };
}

const defaultModules: ExpoPhotoPickerModules = {
  async launch(mode) {
    const permission =
      mode === 'take'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new PrescriptionPhotoPermissionError();
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
      exif: false,
    };
    const result =
      mode === 'take'
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled || !result.assets?.[0]) return null;
    const asset = result.assets[0];
    return { uri: asset.uri, width: asset.width, height: asset.height };
  },
  async toJpeg(uri, size, quality) {
    const context = ImageManipulator.manipulate(uri);
    if (size) context.resize(size);
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: quality });
    return { uri: saved.uri, width: saved.width, height: saved.height };
  },
  async readBytes(uri) {
    return new Uint8Array(await new File(uri).arrayBuffer());
  },
  deleteLocal(uri) {
    try {
      // Only the app's own cache copies; never a file elsewhere on the phone.
      if (!uri.startsWith(Paths.cache.uri)) return;
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // A leftover copy in the app's cache folder is removed by the system; never fail the scan.
    }
  },
};

/**
 * The camera and library adapter for `/meds/scan`. Always returns a JPEG whose long edge is at
 * most `maxDimensionPx` and whose size is at most 2 MB (quality 0.8 first, lower only if needed).
 * Local copies of the photo are deleted once the bytes are read.
 */
export function createExpoPrescriptionPhotoPicker(
  modules: ExpoPhotoPickerModules = defaultModules,
) {
  async function capture(
    mode: 'take' | 'pick',
    options: CaptureOptions,
  ): Promise<CapturedPrescriptionPhoto | null> {
    const picked = await modules.launch(mode);
    if (!picked) return null;
    const created: string[] = [];
    try {
      const resize = targetResize(picked.width, picked.height, options.maxDimensionPx);
      for (const quality of [options.jpegQuality, ...FALLBACK_JPEG_QUALITIES]) {
        const jpeg = await modules.toJpeg(picked.uri, resize, quality);
        created.push(jpeg.uri);
        const bytes = await modules.readBytes(jpeg.uri);
        if (bytes.byteLength > 0 && bytes.byteLength <= MAX_PRESCRIPTION_PHOTO_BYTES) {
          return { bytes, width: jpeg.width, height: jpeg.height, contentType: 'image/jpeg' };
        }
      }
      throw new Error('PHOTO_TOO_LARGE');
    } finally {
      for (const uri of created) modules.deleteLocal(uri);
      // expo-image-picker hands back a copy in the app's cache folder; the person's own photo in
      // their library is never touched (deleteLocal only removes files in the cache folder).
      modules.deleteLocal(picked.uri);
    }
  }

  return {
    takePhoto: (options: CaptureOptions) => capture('take', options),
    pickPhoto: (options: CaptureOptions) => capture('pick', options),
  };
}
