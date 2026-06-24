# E2E fixtures

One clean example of each CriticMarkup kind, so the smoke spec can assert on a
known decoration class. Keep these lines stable — specs match against them.

Insertion: the cat sat on the {++warm ++}mat.

Deletion: the cat sat on the {--cold --}mat.

Substitution: the {~~dog~>cat~~} sat on the mat.

Comment: the cat sat on the mat.{>>is this right?<<}

Highlight: {==the cat sat on the mat==} is the topic sentence.
