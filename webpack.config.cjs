const path = require('path');
const webpack = require('webpack');

module.exports = {
  target: 'node',
  mode: 'production',
  entry: './dist/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'build.cjs',
    libraryTarget: 'commonjs2',
  },
  module: {
    rules: [
      {
        test: /\.node$/,
        use: 'node-loader',
      },
    ],
  },
  externals: [
    function (context, request, callback) {
      if (/^bufferutil$|^utf-8-validate$|^d3-dsv$|^mammoth$|^epub2$|^html-to-text$|^pdfjs-dist$|^srt-parser-2$|^cheerio$|^puppeteer$/.test(request)) {
        return callback(null, 'commonjs ' + request);
      }
      callback();
    },
  ],  
};
