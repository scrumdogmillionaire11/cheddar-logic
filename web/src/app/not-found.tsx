export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-cloud/60">Page not found.</p>
      <a href="/" className="text-sm underline opacity-70 hover:opacity-100">
        Go home
      </a>
    </div>
  );
}
