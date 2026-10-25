# Third-party notices

## assets/plotly.min.js

- plotly.js v3.0.1, unmodified distribution bundle `plotly.min.js`
- Copyright (c) 2012-2025 Plotly, Inc. — MIT License
- Source: https://github.com/plotly/plotly.js
- This is the **single shared copy** for the whole HarnessAMSproject tree: the SmartAnaSim
  report generator (`scripts/gen_sweep_report.py`) and the LocalDesignExample pipeline copies
  (`LocalDesignExample/tools/`) discover it by walking up from their own location (or via the
  workspace `harnessams.json` `plotly_asset` field) and place a copy beside each generated
  report so reports render fully offline. Do not add a second copy anywhere else.
- License text (from the upstream repository):

```
MIT License

Copyright (c) 2012-2025 Plotly, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
