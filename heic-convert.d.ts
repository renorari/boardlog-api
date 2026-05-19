declare module "heic-convert" {
    interface ConvertOptions {
        buffer: Buffer | Uint8Array;
        format: "JPEG" | "PNG";
        quality?: number;
    }

    interface ConvertibleImage {
        convert: () => Promise<Uint8Array>;
    }

    function convert(_options: ConvertOptions): Promise<Uint8Array>;

    namespace convert {
        function all(_options: ConvertOptions): Promise<ConvertibleImage[]>;
    }

    export default convert;
}
