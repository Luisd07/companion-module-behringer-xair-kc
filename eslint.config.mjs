import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	commonRules: {
		// Companion callbacks get (action, context) / (feedback, context) whether they use them or not
		'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_(.+)' }],
	},
})

export default [
	...baseConfig,
	{
		// this module is plain ES modules JavaScript
		files: ['**/*.js'],
		languageOptions: { sourceType: 'module' },
	},
]
