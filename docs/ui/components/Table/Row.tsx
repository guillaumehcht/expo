import { mergeClasses } from '@expo/styleguide';
import { PropsWithChildren } from 'react';

type RowProps = PropsWithChildren<{
  subtle?: boolean;
}>;

export const Row = ({ children, subtle }: RowProps) => (
  <tr
    className={mergeClasses(
      'even:bg-subtle',
      'even:[&_summary]:bg-element',
      'even:[&_blockquote]:bg-default',
      subtle && 'opacity-50'
    )}>
    {children}
  </tr>
);
