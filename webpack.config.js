const webpack = require("webpack");
const path = require("path");
const { merge } = require("webpack-merge");
const nodeExternals = require('webpack-node-externals');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const TerserPlugin = require("terser-webpack-plugin");

const common = {
  entry: "./src/index.ts",
  output: {
    filename: "bundle.js",
    path: path.resolve(__dirname, "dist"),
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".json"],
    fallback: {
      buffer: require.resolve("buffer/"),
      path: require.resolve("path-browserify"),
      util: require.resolve("util/"),
      stream: require.resolve("stream-browserify"),
      crypto: require.resolve("crypto-browserify"),
      tls: false,
      net: false,
      fs: false,
      url: require.resolve('url/'),      
      process: require.resolve("process/browser")      
    },
    alias: {
      'process/browser$': require.resolve('process/browser.js'),
      'hnswlib-node$': path.join(__dirname, 'node_modules/hnswlib-node'),
      'node_modules': path.resolve(__dirname, 'dist/node_modules'),
    },
  },  
  externals: [
    nodeExternals({
      allowlist: [/^hnswlib-node/], // This will allow bundling JavaScript part of 'hnswlib-node'
      additionalModuleDirs: [path.join(__dirname, 'dist/node_modules')], // Add this line to include the 'dist/node_modules' path
    }),
  ],
  optimization: {
    providedExports: false,
    usedExports: false,
    sideEffects: false,
    minimize: false,
    minimizer: [
      new TerserPlugin({
        exclude: [
          /\.min\.js$/,
          /node_modules/,
          /\.bin/,
          /test/,
          // You can add any other directories or files you want to exclude
        ],
        terserOptions: {
          // Your Terser options
        },
      }),
    ],
  },
  target: 'node',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: "ts-loader",
        exclude: /node_modules/,
      },
      {
        test: /\.node$/,
        loader: "node-loader",
      },
    ],
  },
  experiments: {
    asyncWebAssembly: true,
  },
  
  output: {
    // ... your other output configurations ...
    libraryTarget: 'commonjs2',
  },

  plugins: [
    // ... your other plugins ...
    new webpack.ProvidePlugin({
      process: 'process/browser',
      Buffer: ['buffer', 'Buffer'],
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'node_modules',
          to: 'node_modules',
          force: true,
          globOptions: {
            ignore: [
              // Add any patterns to ignore, e.g.:
              // '**/test/**/*',
            ],
          },
        },
        // Add this pattern to copy the native module of 'hnswlib-node'
        {
          from: 'node_modules/hnswlib-node/build/Release',
          to: 'node_modules/hnswlib-node/build/Release',
        },
      ],
    }),
  ],
};

const production = {
  mode: "production",
};

const development = {
  mode: "development",
  devtool: "inline-source-map",
};

module.exports = (env) => {
  if (env.production) {
    return merge(common, production);
  }
  return merge(common, development);
};
