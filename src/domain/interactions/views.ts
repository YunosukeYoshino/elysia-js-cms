/** 公開可能な利用者情報。メール・認証情報は含めない。 */
export interface PublicUser {
  id: number;
  name: string | null;
}

/** コメントの参照用データ。削除後は本文・著者を null にする。 */
export interface CommentView {
  id: number;
  revision: number;
  postId: number;
  parentId: number | null;
  content: string | null;
  author: PublicUser | null;
  status: string;
  published: boolean;
  deleted: boolean;
  depth: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 利用者が保存した投稿の最小情報。 */
export interface BookmarkView {
  id: number;
  createdAt: Date;
  post: { id: number; title: string; author: PublicUser };
}

/** 自分に関係するフォロー情報。 */
export interface FollowView {
  id: number;
  createdAt: Date;
  user: PublicUser;
}

/** 自分に届いた通知。内部イベントキーや宛先 ID を含めない。 */
export interface NotificationView {
  id: number;
  type: string;
  content: string;
  read: boolean;
  createdAt: Date;
  postId: number | null;
  commentId: number | null;
  sender: PublicUser | null;
}

/** 投稿の公開集計。閲覧者の識別情報は返さない。 */
export interface InteractionStats {
  views: number;
  reactions: number;
  comments: number;
}

/** 種類別の件数と自分自身の選択。 */
export interface ReactionSummary {
  counts: { type: string; count: number }[];
  mine: string[];
}

/** 人気順リストの投稿と指標。 */
export interface PopularPost {
  id: number;
  title: string;
  author: PublicUser;
  _count: { views: number; reactions: number };
}
