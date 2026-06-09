/** DocumentPicker seam — <input type="file"> on web. */
export type DocumentPickerAsset = { uri: string; name: string; size?: number; mimeType?: string };
type Result = { canceled: boolean; assets: DocumentPickerAsset[] | null };
type Options = { type?: string | string[]; multiple?: boolean; copyToCacheDirectory?: boolean };

export async function getDocumentAsync(opts: Options = {}): Promise<Result> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (opts.type && opts.type !== "*/*") {
      input.accept = Array.isArray(opts.type) ? opts.type.join(",") : opts.type;
    }
    if (opts.multiple) input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    let done = false;
    const finish = (r: Result) => { if (done) return; done = true; input.remove(); resolve(r); };
    input.onchange = () => {
      const files = Array.from(input.files || []);
      if (!files.length) return finish({ canceled: true, assets: null });
      finish({
        canceled: false,
        assets: files.map((f) => ({ uri: URL.createObjectURL(f), name: f.name, size: f.size, mimeType: f.type })),
      });
    };
    // No reliable "cancel" event for the file dialog — detect via window focus.
    window.addEventListener("focus", () => {
      setTimeout(() => { if (!input.files || !input.files.length) finish({ canceled: true, assets: null }); }, 500);
    }, { once: true });
    input.click();
  });
}
