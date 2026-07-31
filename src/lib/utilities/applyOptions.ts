import type { Piece, PieceOptions } from "@sapphire/pieces";

/**
 * Declaratively sets a piece's constructor options via a class decorator,
 * instead of overriding the constructor to call `super(context, options)`.
 *
 * @remarks `@sapphire/decorators`'s `ApplyOptions` cannot be used here: its
 * bundled entrypoint statically imports `@sapphire/discord.js-utilities`,
 * which requires the `discord.js` package that this http-interactions-only
 * project intentionally does not depend on.
 */
export function ApplyOptions<Options extends PieceOptions>(
	options: Options,
): ClassDecorator {
	return (target) =>
		new Proxy(target, {
			construct(ctor, [context, baseOptions]: [Piece.LoaderContext, Options?]) {
				return Reflect.construct(ctor, [
					context,
					{ ...baseOptions, ...options },
				]);
			},
		}) as unknown as typeof target;
}
