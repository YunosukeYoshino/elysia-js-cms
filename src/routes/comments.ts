import { Elysia, t } from 'elysia';
import prisma from '../lib/prisma';
import { authenticated, authMiddleware }from '../middlewares/auth';

export const commentsRouter = new Elysia({ prefix: '/comments' })
  .use(authMiddleware)
  // Create a new comment
  .post(
    '/',
    async ({ body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const { content, postId } = body;

      try {
        const comment = await prisma.comment.create({
          data: {
            content,
            postId,
            authorId: user.id,
          },
          include: {
            author: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        });
        return comment;
      } catch (error) {
        set.status = 400;
        return { error: 'Failed to create comment', details: error };
      }
    },
    {
      body: t.Object({
        content: t.String(),
        postId: t.Number(),
      }),
      beforeHandle: [authenticated],
      detail: {
        tags: ['comments'],
        summary: 'Create a new comment',
        description: 'Creates a new comment on a post. Authentication is required.',
        security: [{ bearerAuth: [] }],
      },
    },
  )
  // Get comments for a post
  .get(
    '/post/:postId',
    async ({ params }) => {
      const { postId } = params;
      const comments = await prisma.comment.findMany({
        where: { postId: Number(postId) },
        include: {
          author: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: 'asc',
        },
      });
      return comments;
    },
    {
      params: t.Object({
        postId: t.String(),
      }),
      detail: {
        tags: ['comments'],
        summary: 'Get comments for a post',
        description: 'Retrieves all comments for a specific post.',
      },
    },
  )
  // Update a comment
  .put(
    '/:id',
    async ({ params, body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const { id } = params;
      const { content } = body;

      const comment = await prisma.comment.findUnique({
        where: { id: Number(id) },
      });

      if (!comment) {
        set.status = 404;
        return { error: 'Comment not found' };
      }

      if (comment.authorId !== user.id && user.role !== 'admin') {
        set.status = 403;
        return { error: 'You do not have permission to update this comment' };
      }

      try {
        const updatedComment = await prisma.comment.update({
          where: { id: Number(id) },
          data: { content },
          include: {
            author: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        });
        return updatedComment;
      } catch (error) {
        set.status = 400;
        return { error: 'Failed to update comment', details: error };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        content: t.String(),
      }),
      beforeHandle: [authenticated],
      detail: {
        tags: ['comments'],
        summary: 'Update a comment',
        description: 'Updates an existing comment. Requires authentication and ownership.',
        security: [{ bearerAuth: [] }],
      },
    },
  )
  // Delete a comment
  .delete(
    '/:id',
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const { id } = params;

      const comment = await prisma.comment.findUnique({
        where: { id: Number(id) },
      });

      if (!comment) {
        set.status = 404;
        return { error: 'Comment not found' };
      }

      if (comment.authorId !== user.id && user.role !== 'admin') {
        set.status = 403;
        return { error: 'You do not have permission to delete this comment' };
      }

      try {
        await prisma.comment.delete({
          where: { id: Number(id) },
        });
        return { message: 'Comment deleted successfully' };
      } catch (error) {
        set.status = 400;
        return { error: 'Failed to delete comment', details: error };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      beforeHandle: [authenticated],
      detail: {
        tags: ['comments'],
        summary: 'Delete a comment',
        description: 'Deletes a comment. Requires authentication and ownership.',
        security: [{ bearerAuth: [] }],
      },
    },
  );
