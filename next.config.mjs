/** @type {import('next').NextConfig} */
const nextConfig = {
  // The server reads proof artifacts at request time. Include the tracked holdout set
  // in deployment output even though filenames are discovered dynamically.
  outputFileTracingIncludes: {
    '/*': ['./runs/**/*'],
  },
};

export default nextConfig;
