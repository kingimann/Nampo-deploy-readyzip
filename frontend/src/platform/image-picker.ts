/** ImagePicker seam — <input type="file"> + FileReader on web. */
export enum MediaTypeOptions { All = "All", Images = "Images", Videos = "Videos" }
export type ImagePickerAsset = {
  uri: string; base64?: string | null; width?: number; height?: number;
  type?: "image" | "video"; fileName?: string | null; mimeType?: string; fileSize?: number;
};
type Result = { canceled: boolean; assets: ImagePickerAsset[] | null };
type Options = {
  mediaTypes?: any; allowsMultipleSelection?: boolean; selectionLimit?: number;
  quality?: number; base64?: boolean; allowsEditing?: boolean; videoMaxDuration?: number;
};
type Perm = { granted: boolean; status: "granted"; canAskAgain: boolean; expires: "never" };
const GRANTED: Perm = { granted: true, status: "granted", canAskAgain: true, expires: "never" };

function acceptFor(mediaTypes: any): string {
  const arr = Array.isArray(mediaTypes) ? mediaTypes.map(String) : [String(mediaTypes ?? "")];
  const imgs = arr.some((t) => /image/i.test(t)) || arr.some((t) => /^All$|Images/i.test(t));
  const vids = arr.some((t) => /video/i.test(t)) || arr.some((t) => /^All$|Videos/i.test(t));
  if (vids && !imgs) return "video/*";
  if (vids && imgs) return "image/*,video/*";
  return "image/*";
}

async function toAsset(file: File, wantBase64: boolean): Promise<ImagePickerAsset> {
  const dataUrl: string = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onloadend = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const isVideo = /^video\//.test(file.type);
  let width: number | undefined, height: number | undefined;
  if (!isVideo) {
    await new Promise<void>((res) => {
      const im = new window.Image();
      im.onload = () => { width = im.naturalWidth; height = im.naturalHeight; res(); };
      im.onerror = () => res();
      im.src = dataUrl;
    });
  }
  return {
    uri: dataUrl,
    base64: wantBase64 ? dataUrl.split(",")[1] : null,
    width, height,
    type: isVideo ? "video" : "image",
    fileName: file.name, mimeType: file.type, fileSize: file.size,
  };
}

function pick(opts: Options, capture: boolean): Promise<Result> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = acceptFor(opts.mediaTypes);
    if (opts.allowsMultipleSelection) input.multiple = true;
    if (capture) (input as any).capture = "environment";
    input.style.display = "none";
    document.body.appendChild(input);
    let done = false;
    const finish = (r: Result) => { if (done) return; done = true; input.remove(); resolve(r); };
    input.onchange = async () => {
      let files = Array.from(input.files || []);
      if (!files.length) return finish({ canceled: true, assets: null });
      if (opts.selectionLimit && opts.selectionLimit > 0) files = files.slice(0, opts.selectionLimit);
      const assets = await Promise.all(files.map((f) => toAsset(f, !!opts.base64)));
      finish({ canceled: false, assets });
    };
    window.addEventListener("focus", () => {
      setTimeout(() => { if (!input.files || !input.files.length) finish({ canceled: true, assets: null }); }, 500);
    }, { once: true });
    input.click();
  });
}

export async function launchImageLibraryAsync(opts: Options = {}): Promise<Result> { return pick(opts, false); }
export async function launchCameraAsync(opts: Options = {}): Promise<Result> { return pick(opts, true); }
export async function requestMediaLibraryPermissionsAsync(): Promise<Perm> { return GRANTED; }
export async function requestCameraPermissionsAsync(): Promise<Perm> { return GRANTED; }
export async function getMediaLibraryPermissionsAsync(): Promise<Perm> { return GRANTED; }
export async function getCameraPermissionsAsync(): Promise<Perm> { return GRANTED; }
