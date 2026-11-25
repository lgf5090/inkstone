export default {
  rules: {
    'at-rule-no-unknown': [true, {
      ignoreAtRules: ['theme', 'utility', 'apply', 'source', 'tailwind', 'config', 'plugin', 'variant', 'custom-variant', 'reference', 'import'],
    }],
    'block-no-empty': true,
    'no-invalid-double-slash-comments': true,
    'property-no-unknown': true,
    'selector-pseudo-class-no-unknown': true,
  },
}
