/**
 * DATA TRANSPARENCY — Footer Level
 * 
 * Visible but unobtrusive. Shows data freshness and warnings.
 */

interface DataTransparencyProps {
  projectionWindow?: string;
  updatedAt?: string;
  warnings?: string[];
}

export default function DataTransparency({ 
  projectionWindow, 
  updatedAt, 
  warnings 
}: DataTransparencyProps) {
  const formatTimestamp = (timestamp?: string) => {
    if (!timestamp) return 'Unknown';
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMins = Math.floor(diffMs / (1000 * 60));
      
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      return date.toLocaleDateString();
    } catch {
      return timestamp;
    }
  };

  return (
    <footer className="bg-surface-elevated border-t border-surface-card p-6 text-body-sm text-sage-light">
      <div className="max-w-4xl mx-auto space-y-2">
        {projectionWindow && (
          <div>
            <span className="font-medium">Projection window: </span>
            {projectionWindow}
          </div>
        )}
        
        {updatedAt && (
          <div>
            <span className="font-medium">Updated: </span>
            {formatTimestamp(updatedAt)}
          </div>
        )}

        {warnings && warnings.length > 0 && (
          <div className="text-veto pt-2 space-y-1">
            <div className="font-medium">⚠ Data warnings:</div>
            {warnings.map((warning, idx) => (
              <div key={idx} className="ml-4">• {warning}</div>
            ))}
          </div>
        )}
      </div>
    </footer>
  );
}
