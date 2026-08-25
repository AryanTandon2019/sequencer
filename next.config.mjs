/** @type {import('next').NextConfig} */
const nextConfig = {
  // The server reads proof artifacts at request time. Include the tracked holdout set
  // in deployment output even though filenames are discovered dynamically.
  outputFileTracingIncludes: {
    '/*': ['./runs/**/*'],
  },
  // src/ is written NodeNext-style: relative imports end in `.js` naming the emitted
  // file. tsx and node --test resolve that natively, which is why the harness needs
  // no bundler. The webhook route now shares that graph at runtime, so teach webpack
  // the same mapping (`--webpack` on build/dev; Turbopack has no equivalent today).
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve?.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
