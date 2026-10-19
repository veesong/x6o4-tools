// HTML 预处理与清洗（epub 与 Markdown 两条产物线共用）：
// 1) 懒加载图片回填（data-src 等属性 → src，无法回填的移除并留占位）——RSS 正文常见懒加载标记；
// 2) sanitize-html 白名单清洗（script/style/内嵌框架等一并剥除，双保险）。
const sanitizeHtml = require('sanitize-html');

const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-echo'];

function backfillLazyImages(html) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    // 边界注意：data-src 里含 "src"，必须要求 src 前有空白分隔，否则懒加载图会被误判
    if (/(^|\s)src\s*=/i.test(tag)) return tag;
    for (const attr of LAZY_ATTRS) {
      const m = tag.match(new RegExp(attr + '\\s*=\\s*["\']([^"\']+)["\']', 'i'));
      if (m) return tag.replace(new RegExp(attr, 'i'), 'src');
    }
    return '<p>[图片已省略]</p>'; // 修不好懒加载的图直接移除，不留坏引用
  });
}

// 白名单：常见语义标签；图片保留 src/alt/宽高。
const SANITIZE_OPTS = {
  allowedTags: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'strong', 'em', 'b', 'i', 'sub', 'sup', 'dl', 'dt', 'dd', 'span',
    'a', 'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'width', 'height'],
    '*': ['colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
  nonTextTags: ['script', 'style', 'textarea', 'noscript', 'iframe'],
};

function cleanHtml(html) {
  return sanitizeHtml(backfillLazyImages(html || ''), SANITIZE_OPTS);
}

module.exports = { backfillLazyImages, cleanHtml, SANITIZE_OPTS };
