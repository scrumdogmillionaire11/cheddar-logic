'use client';

import { useRef, useState } from 'react';
import { parseScreenshot, type ScreenshotParseResponse } from '@/lib/fpl-api';

interface FPLScreenshotUploaderProps {
  onParsed: (result: ScreenshotParseResponse) => void;
}

export default function FPLScreenshotUploader({ onParsed }: FPLScreenshotUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Strip the data-URL prefix to get pure base64
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
      reader.readAsDataURL(file);
    });

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).slice(0, 3);
    if (files.length === 0) return;

    setError(null);
    setFileNames(files.map((f) => f.name));
    setLoading(true);

    try {
      const base64Images = await Promise.all(files.map(readFileAsBase64));
      const result = await parseScreenshot({ images: base64Images });
      onParsed(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse screenshot');
    } finally {
      setLoading(false);
      // Reset input so the same file can be re-selected
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 font-display text-2xl font-semibold">Squad Audit</h2>
        <p className="text-cloud/60">
          Upload 1–3 screenshots of your FPL app to parse your current squad.
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-cloud/20 bg-surface/50 p-8 text-center space-y-4">
        <p className="text-3xl">📸</p>
        <p className="text-sm text-cloud/60">
          Select up to 3 FPL app screenshots. Parsing starts automatically on upload.
        </p>

        <label className="inline-block cursor-pointer rounded-lg bg-teal px-5 py-2.5 text-sm font-semibold text-night hover:opacity-90 transition-opacity">
          {loading ? 'Parsing…' : 'Choose screenshots'}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleChange}
            disabled={loading}
            className="sr-only"
          />
        </label>

        {fileNames.length > 0 && !loading && (
          <div className="text-xs text-cloud/40 space-y-0.5">
            {fileNames.map((name) => (
              <p key={name}>{name}</p>
            ))}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 text-sm text-cloud/60">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-teal border-t-transparent" />
            Parsing screenshots…
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
