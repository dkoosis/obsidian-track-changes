# Markup inside code must be left ALONE

Hard contract (CLAUDE.md): CriticMarkup inside code is **not** parsed or
decorated. This note contains markup ONLY inside code, so a spec can assert
that no decoration class appears anywhere in the editor.

Inline code: use `{++this++}` and `{--that--}` literally — not decorated.

Fenced block:

```md
the cat {~~sat~>lounged~~} on the mat
{++inserted++} and {--deleted--} and {>>comment<<}
{==highlight==}
```

Indented block (4 spaces):

    the cat {~~sat~>lounged~~} on the mat
    {++inserted++} and {--deleted--}

Tilde fence:

~~~
{++still inside code++} {--so skipped--}
~~~
