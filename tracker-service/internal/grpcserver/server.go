// Package grpcserver implements the TrackerService gRPC server.
//
// It delegates all business logic to kanban.Service and handles
// only the gRPC transport concerns: metadata extraction, error mapping,
// and type conversion between the domain model and proto messages.
package grpcserver

import (
	"context"
	"errors"

	pb "jobmate/tracker-service/internal/pb"

	"jobmate/tracker-service/internal/kanban"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Server implements pb.TrackerServiceServer.
type Server struct {
	pb.UnimplementedTrackerServiceServer
	svc *kanban.Service
}

// NewServer constructs a gRPC Server backed by the given kanban.Service.
func NewServer(svc *kanban.Service) *Server {
	return &Server{svc: svc}
}

// ─── RPC implementations ──────────────────────────────────────────────────────

// ListApplications returns all applications belonging to the caller.
func (s *Server) ListApplications(ctx context.Context, req *pb.ListApplicationsRequest) (*pb.ListApplicationsResponse, error) {
	userID, err := userIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	apps, err := s.svc.ListApplications(ctx, userID, req.StatusFilter)
	if err != nil {
		return nil, toGRPCError(err)
	}

	protos := make([]*pb.ApplicationProto, 0, len(apps))
	for i := range apps {
		protos = append(protos, appToProto(&apps[i]))
	}

	return &pb.ListApplicationsResponse{Applications: protos}, nil
}

// MoveCard transitions an application to a new Kanban status.
func (s *Server) MoveCard(ctx context.Context, req *pb.MoveCardRequest) (*pb.ApplicationProto, error) {
	userID, err := userIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	app, err := s.svc.MoveCard(ctx, userID, req.ApplicationId, req.NewStatus)
	if err != nil {
		return nil, toGRPCError(err)
	}

	return appToProto(app), nil
}

// AddNote updates the free-text note on an application.
func (s *Server) AddNote(ctx context.Context, req *pb.AddNoteRequest) (*pb.ApplicationProto, error) {
	userID, err := userIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	app, err := s.svc.AddNote(ctx, userID, req.ApplicationId, req.Note)
	if err != nil {
		return nil, toGRPCError(err)
	}

	return appToProto(app), nil
}

// RateApplication sets a numeric rating (1-5) on an application.
func (s *Server) RateApplication(ctx context.Context, req *pb.RateApplicationRequest) (*pb.ApplicationProto, error) {
	userID, err := userIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	app, err := s.svc.RateApplication(ctx, userID, req.ApplicationId, req.Rating)
	if err != nil {
		return nil, toGRPCError(err)
	}

	return appToProto(app), nil
}

// GetApplication returns a single application by ID.
func (s *Server) GetApplication(ctx context.Context, req *pb.GetApplicationRequest) (*pb.ApplicationProto, error) {
	userID, err := userIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	app, err := s.svc.GetApplication(ctx, userID, req.ApplicationId)
	if err != nil {
		return nil, toGRPCError(err)
	}

	return appToProto(app), nil
}

// CreateApplication creates a new application for the given job feed entry.
func (s *Server) CreateApplication(ctx context.Context, req *pb.CreateApplicationRequest) (*pb.ApplicationProto, error) {
	userID, err := userIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	app, err := s.svc.CreateApplication(ctx, userID, req.JobFeedId)
	if err != nil {
		return nil, toGRPCError(err)
	}

	return appToProto(app), nil
}

// SetRelanceReminder sets the follow-up reminder timestamp on an application.
func (s *Server) SetRelanceReminder(ctx context.Context, req *pb.SetRelanceReminderRequest) (*pb.ApplicationProto, error) {
	userID, err := userIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	app, err := s.svc.SetRelanceReminder(ctx, userID, req.ApplicationId, req.RemindAt)
	if err != nil {
		return nil, toGRPCError(err)
	}

	return appToProto(app), nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// userIDFromCtx extracts the x-user-id value forwarded by the Gateway
// via gRPC metadata.
func userIDFromCtx(ctx context.Context) (string, error) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return "", status.Error(codes.Unauthenticated, "missing metadata")
	}
	vals := md.Get("x-user-id")
	if len(vals) == 0 || vals[0] == "" {
		return "", status.Error(codes.Unauthenticated, "missing x-user-id metadata")
	}
	return vals[0], nil
}

// toGRPCError maps domain errors to gRPC status errors.
func toGRPCError(err error) error {
	if errors.Is(err, kanban.ErrNotFound) {
		return status.Error(codes.NotFound, err.Error())
	}
	var ve *kanban.ValidationError
	if errors.As(err, &ve) {
		return status.Error(codes.InvalidArgument, ve.Msg)
	}
	return status.Error(codes.Internal, "internal server error")
}

// appToProto converts a kanban.Application to its proto representation.
func appToProto(a *kanban.Application) *pb.ApplicationProto {
	p := &pb.ApplicationProto{
		Id:             a.ID,
		CurrentStatus:  a.CurrentStatus,
		AiAnalysis:     []byte(a.AIAnalysis),
		HistoryLog:     []byte(a.HistoryLog),
		JobFeedId:      a.JobFeedID,
		SearchConfigId: a.SearchConfigID,
		CreatedAt:      timestamppb.New(a.CreatedAt),
		UpdatedAt:      timestamppb.New(a.UpdatedAt),
	}

	if a.GeneratedCoverLetter != nil {
		p.GeneratedCoverLetter = *a.GeneratedCoverLetter
	}
	if a.UserNotes != nil {
		p.UserNotes = *a.UserNotes
	}
	if a.UserRating != nil {
		p.UserRating = *a.UserRating
	}
	if a.RelanceReminderAt != nil {
		p.RelanceReminderAt = a.RelanceReminderAt.UTC().Format("2006-01-02T15:04:05Z")
	}

	return p
}
