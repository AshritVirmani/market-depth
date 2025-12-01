const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
    entry: {
        content: './src/index.js',
        background: './src/background.js'
    },
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'dist'),
        clean: true,
    },
    // 🔧 FIX: Use source-map instead of eval to avoid CSP violations
    devtool: false, // Disable source maps in production to avoid CSP issues
    optimization: {
        minimize: false
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                {
                    from: "manifest.json",
                    to: ".",
                    transform(content) {
                        const manifest = JSON.parse(content.toString());
                        // In dist, content.js is in the root of dist, not dist/dist/content.js
                        if (manifest.content_scripts) {
                            manifest.content_scripts.forEach(script => {
                                if (script.js) {
                                    script.js = script.js.map(f => f.replace('dist/', ''));
                                }
                            });
                        }
                        return JSON.stringify(manifest, null, 2);
                    }
                },
                { from: "popup.html", to: "." },
                { from: "viewer.html", to: "." },
                // Copy any other assets if needed
            ],
        }),
    ],
};


