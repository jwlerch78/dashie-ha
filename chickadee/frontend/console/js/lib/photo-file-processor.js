/* ============================================================
   PhotoFileProcessor — Console vendor copy

   Mirrors js/modules/Settings/photos/utils/photo-file-processor.js
   from the dashboard. Handles:

   - HEIC/HEIF → JPEG conversion via window.heic2any (loaded from CDN
     in index.html before this script)
   - Compress + resize (max 1920px, JPEG 0.85)
   - Thumbnail generation (300×300 max, JPEG 0.85)
   - File metadata extraction

   Vendored as a global class (no ES-module exports) so it works in the
   Console's script-tag-load model. Logger uses console.* directly
   instead of the dashboard's createLogger.

   ⚠ Keep in sync with the dashboard original. When the dashboard
   version is updated, mirror the change here. Cross-tracked in
   .reference/_TECHNICAL_DEBT.md.
   ============================================================ */

(function () {
    // Tiny logger shim — matches the dashboard processor's API surface
    // (debug / info / success / warn / error) without pulling in the
    // dashboard's full createLogger module.
    const logger = {
        debug:   (msg, data) => console.debug('[PhotoFileProcessor]', msg, data || ''),
        info:    (msg, data) => console.info('[PhotoFileProcessor]', msg, data || ''),
        success: (msg, data) => console.info('[PhotoFileProcessor]', msg, data || ''),
        warn:    (msg, data) => console.warn('[PhotoFileProcessor]', msg, data || ''),
        error:   (msg, data) => console.error('[PhotoFileProcessor]', msg, data || ''),
    };

    class PhotoFileProcessor {
        constructor(options = {}) {
            this.thumbnailMaxWidth = options.thumbnailMaxWidth || 300;
            this.thumbnailMaxHeight = options.thumbnailMaxHeight || 300;
            this.thumbnailQuality = options.thumbnailQuality || 0.85;
            this.conversionQuality = options.conversionQuality || 0.9;
            this.maxDimension = options.maxDimension || 1920;
            this.compressionQuality = options.compressionQuality || 0.85;
        }

        /**
         * Process a file for upload.
         * Returns: { original: File, thumbnail: Blob|null, metadata: Object }
         */
        async processFile(file) {
            try {
                logger.debug('Processing file', {
                    filename: file.name,
                    size: file.size,
                    type: file.type
                });

                const convertedFile = await this.convertToJPEGIfNeeded(file);
                const compressedFile = await this.compressAndResize(convertedFile);
                const thumbnail = await this.generateThumbnail(compressedFile);
                const metadata = this.extractMetadata(compressedFile, file);

                logger.success('File processed', {
                    originalName: file.name,
                    convertedName: compressedFile.name,
                    hasThumbnail: !!thumbnail,
                    originalSize: file.size,
                    compressedSize: compressedFile.size,
                    thumbnailSize: thumbnail?.size || 0
                });

                return { original: compressedFile, thumbnail, metadata };
            } catch (error) {
                logger.error('File processing failed', { filename: file.name, error: error.message });
                throw error;
            }
        }

        /**
         * Convert HEIC/HEIF to JPEG via window.heic2any. Falls back to
         * renaming the file when the browser already reads it as JPEG
         * (Safari, some pre-converted files). Throws on real conversion
         * failure — the caller should surface that to the user.
         */
        async convertToJPEGIfNeeded(file) {
            const hasHEICExtension = /\.(heic|heif)$/i.test(file.name);
            if (!hasHEICExtension) {
                logger.debug('No conversion needed (not HEIC extension)', { filename: file.name, type: file.type });
                return file;
            }

            logger.debug('Checking HEIC file for conversion', {
                filename: file.name,
                fileSize: file.size,
                fileType: file.type,
                heic2anyAvailable: !!window.heic2any
            });

            // Special case: .heic extension but browser already decodes as JPEG.
            if (file.type === 'image/jpeg' || file.type === 'image/jpg') {
                logger.warn('HEIC file already in JPEG format, renaming only', { filename: file.name, type: file.type });
                const newFilename = this.replaceExtension(file.name, '.jpg');
                return new File([file], newFilename, { type: 'image/jpeg' });
            }

            try {
                if (!window.heic2any) {
                    const errorMsg = 'HEIC conversion library not available — cannot upload HEIC files';
                    logger.error(errorMsg, { filename: file.name });
                    throw new Error(errorMsg);
                }

                const convertedBlob = await window.heic2any({
                    blob: file,
                    toType: 'image/jpeg',
                    quality: this.conversionQuality
                });

                const blob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
                const newFilename = this.replaceExtension(file.name, '.jpg');
                const convertedFile = new File([blob], newFilename, { type: 'image/jpeg' });

                logger.success('HEIC converted to JPEG', {
                    originalName: file.name,
                    newName: newFilename,
                    originalSize: file.size,
                    newSize: convertedFile.size
                });

                return convertedFile;
            } catch (error) {
                logger.debug('heic2any threw an error', {
                    filename: file.name,
                    errorMessage: error.message,
                    errorString: String(error)
                });

                // "Already readable" path — Safari decodes natively, no conversion needed.
                const errorStr = String(error.message || error).toLowerCase();
                if (errorStr.includes('already') && errorStr.includes('readable')) {
                    logger.info('HEIC file already browser-readable, renaming to .jpg', { filename: file.name, fileType: file.type });
                    const newFilename = this.replaceExtension(file.name, '.jpg');
                    return new File([file], newFilename, { type: file.type || 'image/jpeg' });
                }

                logger.error('HEIC conversion failed — skipping file', { filename: file.name, error: error.message });
                throw new Error(`Failed to convert HEIC file "${file.name}" to JPEG: ${error.message}`);
            }
        }

        /**
         * Generate JPEG thumbnail. Returns null on failure — thumbnails
         * are optional and shouldn't fail the upload.
         */
        async generateThumbnail(file) {
            try {
                logger.debug('Generating thumbnail', { filename: file.name });
                const img = await this.loadImage(file);
                const dimensions = this.calculateThumbnailDimensions(
                    img.width, img.height, this.thumbnailMaxWidth, this.thumbnailMaxHeight
                );
                const canvas = document.createElement('canvas');
                canvas.width = dimensions.width;
                canvas.height = dimensions.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, dimensions.width, dimensions.height);
                const thumbnail = await new Promise((resolve, reject) => {
                    canvas.toBlob(
                        (blob) => blob ? resolve(blob) : reject(new Error('Failed to create thumbnail blob')),
                        'image/jpeg',
                        this.thumbnailQuality
                    );
                });
                logger.success('Thumbnail generated', {
                    filename: file.name,
                    originalSize: `${img.width}x${img.height}`,
                    thumbnailSize: `${dimensions.width}x${dimensions.height}`,
                    fileSize: thumbnail.size
                });
                return thumbnail;
            } catch (error) {
                logger.error('Thumbnail generation failed', { filename: file.name, error: error.message });
                return null;
            }
        }

        loadImage(file) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                const url = URL.createObjectURL(file);
                img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
                img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
                img.src = url;
            });
        }

        calculateThumbnailDimensions(width, height, maxWidth, maxHeight) {
            const widthRatio = maxWidth / width;
            const heightRatio = maxHeight / height;
            const scaleFactor = Math.min(widthRatio, heightRatio, 1); // never scale up
            return {
                width: Math.round(width * scaleFactor),
                height: Math.round(height * scaleFactor)
            };
        }

        replaceExtension(filename, newExtension) {
            return filename.replace(/\.(heic|heif)$/i, newExtension);
        }

        /**
         * Compress + resize for storage. Files within maxDimension get
         * compressed only; larger files get scaled down to maxDimension
         * on the longest edge. Returns original on failure.
         */
        async compressAndResize(file) {
            try {
                logger.debug('Compressing and resizing image', { filename: file.name, originalSize: file.size });
                const img = await this.loadImage(file);
                const needsResize = img.width > this.maxDimension || img.height > this.maxDimension;
                let newWidth = img.width;
                let newHeight = img.height;
                if (needsResize) {
                    const scale = this.maxDimension / Math.max(img.width, img.height);
                    newWidth = Math.round(img.width * scale);
                    newHeight = Math.round(img.height * scale);
                }
                const canvas = document.createElement('canvas');
                canvas.width = newWidth;
                canvas.height = newHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, newWidth, newHeight);
                const compressedBlob = await new Promise((resolve, reject) => {
                    canvas.toBlob(
                        (blob) => blob ? resolve(blob) : reject(new Error('Failed to compress image')),
                        'image/jpeg',
                        this.compressionQuality
                    );
                });
                const compressedFile = new File([compressedBlob], file.name, { type: 'image/jpeg' });
                logger.success('Image compressed', {
                    filename: file.name,
                    originalDimensions: `${img.width}x${img.height}`,
                    newDimensions: `${newWidth}x${newHeight}`,
                    originalSize: file.size,
                    compressedSize: compressedFile.size,
                    savedBytes: file.size - compressedFile.size
                });
                return compressedFile;
            } catch (error) {
                logger.error('Compression failed, using original', { filename: file.name, error: error.message });
                return file;
            }
        }

        extractMetadata(processedFile, originalFile) {
            return {
                originalFilename: originalFile.name,
                processedFilename: processedFile.name,
                originalSize: originalFile.size,
                processedSize: processedFile.size,
                mimeType: processedFile.type,
                wasConverted: originalFile.name !== processedFile.name,
                uploadedAt: new Date().toISOString()
            };
        }
    }

    // Expose as a global so script-tag callers can `new PhotoFileProcessor(...)`
    window.PhotoFileProcessor = PhotoFileProcessor;
})();
